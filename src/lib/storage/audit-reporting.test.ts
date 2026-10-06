// Which storage operations report a client audit event, with what details, and
// that none of them ever carries content (titles, names, text). Only four events are
// reported at all: meeting.create, meeting.delete, meeting.redact, meeting.audio_delete. The reporter and
// the database are faked; the storage functions under test are the real ones.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MinutesContent, TranscriptSegment } from '@/types';
import { validateEvent } from '@/lib/audit/record';
import type { AuditEventInput } from '@/lib/audit/events';

type Row = Record<string, any>;
const h = vi.hoisted(() => ({ stores: {} as Record<string, Map<string, Row>>, report: vi.fn() }));

const keyOf = (v: Row) => (v.id ?? v.meetingId) as string;

function fakeDb() {
  const s = h.stores;
  const byMeeting = (store: string, meetingId: string) => [...s[store].values()].filter((v) => v.meetingId === meetingId);
  const storeApi = (name: string) => ({
    delete: async (k: string) => void s[name].delete(k),
    index: () => ({ getAll: async (q: string) => byMeeting(name, q) }),
  });
  return {
    get: async (store: string, k: string) => s[store].get(k),
    put: async (store: string, v: Row) => void s[store].set(keyOf(v), { ...v }),
    delete: async (store: string, k: string) => void s[store].delete(k),
    getAllFromIndex: async (store: string, _i: string, q: string) => byMeeting(store, q),
    // `store` is the single-store shorthand deleteAudio uses (audio only).
    transaction: () => ({
      objectStore: storeApi,
      store: { getKey: async (k: string) => (s.audio.has(k) ? k : undefined), delete: storeApi('audio').delete },
      done: Promise.resolve(),
    }),
  };
}

vi.mock('./db', () => ({ getDB: async () => fakeDb() }));
// record.ts opens the database at import time; only validateEvent (pure) is used here.
vi.mock('@/lib/db', () => ({ db: {}, pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@/lib/audit/client', () => ({ reportAuditEvent: h.report }));

import { createMeeting, deleteMeeting, updateMeeting } from './meetings';
import { deleteAudio, saveAudio } from './audio';
import { saveTranscript, saveTranscriptChapters, saveTranscriptSegments } from './transcripts';
import { appendMinutesVersion, saveMinutes, setActiveMinutesVersion, snapshotMinutes } from './minutes';

const SECRET_TITLE = 'Sag om Jensens barn';
const SECRET_NAME = 'Hanne Jensen';
const SECRET_TEXT = 'Vi aftaler at lukke sagen mod hr. Hansen';

const minutes = (text: string): MinutesContent =>
  ({ header: { title: SECRET_TITLE, date: null }, sections: [{ heading: 'Beslutninger', body: text }] }) as unknown as MinutesContent;
const seg = (text: string, speaker = 'Taler 1'): TranscriptSegment => ({ speaker, start: 0, end: 1, text });

const calls = () => h.report.mock.calls.map(([type, entityId, details]) => ({ type, entityId, details }));
const types = () => calls().map((c) => c.type);

/** No call may carry any of the content strings, anywhere in its arguments. */
function expectNoContent() {
  const dump = JSON.stringify(h.report.mock.calls);
  for (const secret of [SECRET_TITLE, SECRET_NAME, SECRET_TEXT, 'Jensen', 'Hansen', 'Beslutninger', 'Taler 1', 'https://']) {
    expect(dump).not.toContain(secret);
  }
}

beforeEach(() => {
  h.stores = { meetings: new Map(), transcripts: new Map(), minutes: new Map(), audio: new Map() };
  h.report.mockReset();
});

describe('meetings', () => {
  it('createMeeting reports meeting.create once with the explicit origin', async () => {
    const m = await createMeeting({ title: SECRET_TITLE, participants: [SECRET_NAME], origin: 'upload', status: 'processing' });
    expect(calls()).toEqual([{ type: 'meeting.create', entityId: m.id, details: { origin: 'upload' } }]);
    expectNoContent();
  });

  it.each(['live', 'upload', 'bot'] as const)('createMeeting passes the origin %s through', async (origin) => {
    await createMeeting({ title: 'x', origin });
    expect(calls()[0].details).toEqual({ origin });
    expectNoContent();
  });

  it('createMeeting still creates the meeting when reporting is silent', async () => {
    const m = await createMeeting({ title: 'x', origin: 'live' });
    expect(h.stores.meetings.get(m.id)?.title).toBe('x');
  });

  describe('updateMeeting', () => {
    let id: string;
    beforeEach(async () => {
      id = (await createMeeting({ title: SECRET_TITLE, participants: [SECRET_NAME], origin: 'live', status: 'recording' })).id;
      h.report.mockReset();
    });

    it('reports nothing for status changes, renames, participant edits and other patches', async () => {
      await updateMeeting(id, { status: 'processing' });
      await updateMeeting(id, { status: 'review', title: 'Et helt andet navn om Hansen', participants: ['A', 'B', 'C'] });
      await updateMeeting(id, { audioSizeBytes: 10, botSession: 'abc', audioDurationSeconds: 5 });
      expect(h.report).not.toHaveBeenCalled();
    });

    it('status becoming redacted reports redact (plus audio_delete when the audio went too), and no status_change', async () => {
      await updateMeeting(id, { status: 'redacted', audioDeleted: true });
      expect(types()).toEqual(['meeting.redact', 'meeting.audio_delete']);
      expectNoContent();
    });

    it('an already redacted meeting does not report redact again', async () => {
      await updateMeeting(id, { status: 'redacted' });
      expect(types()).toEqual(['meeting.redact']);
      await updateMeeting(id, { status: 'redacted' });
      expect(types()).toEqual(['meeting.redact']);
    });

    it('a throwing reporter never fails the write', async () => {
      h.report.mockImplementation(() => {
        throw new Error('reporter down');
      });
      await expect(updateMeeting(id, { status: 'redacted', title: 'Nyt navn' })).resolves.toBeUndefined();
      expect(h.stores.meetings.get(id)?.title).toBe('Nyt navn');
      h.report.mockReset();
    });

    it('audioDeleted false -> true reports audio_delete once; true -> true reports nothing', async () => {
      await updateMeeting(id, { audioDeleted: true });
      expect(types()).toEqual(['meeting.audio_delete']);
      await updateMeeting(id, { audioDeleted: true });
      expect(types()).toEqual(['meeting.audio_delete']);
    });

    it('a missing meeting reports nothing', async () => {
      await updateMeeting('00000000-0000-4000-8000-000000000000', { status: 'redacted' });
      expect(h.report).not.toHaveBeenCalled();
    });
  });

  describe('deleteMeeting', () => {
    it('reports meeting.delete once, after the data is gone', async () => {
      const m = await createMeeting({ title: SECRET_TITLE, origin: 'live' });
      h.report.mockImplementation(() => expect(h.stores.meetings.has(m.id)).toBe(false));
      h.report.mockClear();
      await deleteMeeting(m.id);
      expect(calls()).toEqual([{ type: 'meeting.delete', entityId: m.id, details: undefined }]);
    });

    it('reports nothing for a meeting that does not exist (repeat delete)', async () => {
      await deleteMeeting('00000000-0000-4000-8000-000000000000');
      expect(h.report).not.toHaveBeenCalled();
    });
  });
});

describe('audio', () => {
  it('deleteAudio reports meeting.audio_delete when audio existed', async () => {
    await saveAudio('m1', new Blob(['x']), 'audio/webm');
    await deleteAudio('m1');
    expect(calls()).toEqual([{ type: 'meeting.audio_delete', entityId: 'm1', details: undefined }]);
  });

  it('reports nothing when there was no audio, and saving audio reports nothing', async () => {
    await deleteAudio('m1');
    await saveAudio('m1', new Blob(['x']), 'audio/webm');
    expect(h.report).not.toHaveBeenCalled();
  });
});

describe('transcripts and minutes (edits are not audited)', () => {
  it('transcript writes report nothing: initial save, user edits, diarization and chapters', async () => {
    await saveTranscript('m1', { rawText: SECRET_TEXT, chapters: [], piiReplacements: [], segments: [seg('a'), seg('b')] });
    await saveTranscriptSegments('m1', [seg(SECRET_TEXT, SECRET_NAME), seg('b'), seg('c')]);
    await saveTranscriptSegments('m1', [seg('a', 'Taler 2')], 'done');
    await saveTranscriptChapters('m1', [{ id: 'c1', title: SECRET_TITLE, startIndex: 0, endIndex: 1 }] as never);
    expect(h.report).not.toHaveBeenCalled();
  });

  it('minutes writes report nothing: autosave, snapshot, generate and switching versions', async () => {
    await saveMinutes('m1', minutes(SECRET_TEXT));
    await saveMinutes('m1', minutes('anden tekst'));
    await snapshotMinutes('m1', minutes('y'));
    await appendMinutesVersion('m1', minutes('x'));
    const row = await appendMinutesVersion('m1', minutes('z'));
    await setActiveMinutesVersion('m1', row.versions[0].id);
    expect(h.report).not.toHaveBeenCalled();
  });
});

describe('contract with the server catalogue', () => {
  it('every event the storage layer reports passes the same validation the server applies', async () => {
    const m = await createMeeting({ title: SECRET_TITLE, participants: ['A'], origin: 'bot' });
    await updateMeeting(m.id, { status: 'review', title: 'Nyt', participants: ['A', 'B'], audioDeleted: true });
    await updateMeeting(m.id, { status: 'redacted' });
    await saveTranscript(m.id, { rawText: 't', chapters: [], piiReplacements: [], segments: [seg('a')] });
    await saveMinutes(m.id, minutes('x'));
    await saveAudio(m.id, new Blob(['x']), 'audio/webm');
    await deleteAudio(m.id);
    await deleteMeeting(m.id);

    const seen = new Set(types());
    expect([...seen].sort()).toEqual(['meeting.audio_delete', 'meeting.create', 'meeting.delete', 'meeting.redact']);
    for (const c of calls()) {
      const result = validateEvent({
        type: c.type,
        source: 'client',
        actorUserId: 'user-1',
        entityId: '11111111-2222-4333-8444-555555555555',
        details: c.details ?? {},
      } as AuditEventInput);
      expect(result, `${c.type} ${JSON.stringify(c.details)}`).toMatchObject({ ok: true });
    }
    expectNoContent();
  });
});

// Which storage operations report a client audit event, with what details, and
// that none of them ever carries content (titles, names, text). The reporter and
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
    transaction: () => ({ objectStore: storeApi, done: Promise.resolve() }),
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

  it.each([
    [{ source: 'teams' as const, meetingUrl: 'https://teams.microsoft.com/l/meetup-join/x' }, 'bot'],
    [{ source: 'local' as const }, 'live'],
    [{}, 'live'],
  ])('createMeeting derives a conservative origin when none is given (%j -> %s)', async (extra, origin) => {
    await createMeeting({ title: 'x', ...extra });
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

    it('reports status_change with from and to only', async () => {
      await updateMeeting(id, { status: 'processing' });
      expect(calls()).toEqual([{ type: 'meeting.status_change', entityId: id, details: { fromStatus: 'recording', toStatus: 'processing' } }]);
    });

    it('reports nothing when the status does not change', async () => {
      await updateMeeting(id, { status: 'recording', audioSizeBytes: 10, botSession: 'abc' });
      expect(h.report).not.toHaveBeenCalled();
    });

    it('status becoming redacted reports status_change AND redact (plus audio_delete when the audio went too)', async () => {
      await updateMeeting(id, { status: 'redacted', audioDeleted: true });
      expect(types()).toEqual(['meeting.status_change', 'meeting.redact', 'meeting.audio_delete']);
      expect(calls()[0].details).toEqual({ fromStatus: 'recording', toStatus: 'redacted' });
      expectNoContent();
    });

    it('an already redacted meeting does not report redact again', async () => {
      await updateMeeting(id, { status: 'redacted' });
      h.report.mockReset();
      await updateMeeting(id, { status: 'redacted' });
      expect(h.report).not.toHaveBeenCalled();
    });

    it('a title change reports rename WITHOUT the title; an unchanged title reports nothing', async () => {
      await updateMeeting(id, { title: SECRET_TITLE });
      expect(h.report).not.toHaveBeenCalled();
      await updateMeeting(id, { title: 'Et helt andet navn om Hansen' });
      expect(calls()).toEqual([{ type: 'meeting.rename', entityId: id, details: undefined }]);
      expect(JSON.stringify(h.report.mock.calls)).not.toContain('Hansen');
      expect(JSON.stringify(h.report.mock.calls)).not.toContain('helt andet');
    });

    it('a participants change reports only the count; identical participants report nothing', async () => {
      await updateMeeting(id, { participants: [SECRET_NAME] });
      expect(h.report).not.toHaveBeenCalled();
      await updateMeeting(id, { participants: [SECRET_NAME, 'Ib Hansen', 'Pia'] });
      expect(calls()).toEqual([{ type: 'meeting.participants_edit', entityId: id, details: { participantCount: 3 } }]);
      expectNoContent();
    });

    it('an automatic write (the bot roster) still reports status changes but never participants_edit', async () => {
      await updateMeeting(id, { status: 'processing', participants: ['A', 'B'] }, { automatic: true });
      expect(types()).toEqual(['meeting.status_change']);
      await updateMeeting(id, { participants: ['A', 'B', 'C'] }, { automatic: true });
      expect(types()).toEqual(['meeting.status_change']);
      // The same write without the flag is a user edit.
      await updateMeeting(id, { participants: ['A'] });
      expect(types()).toEqual(['meeting.status_change', 'meeting.participants_edit']);
    });

    it('audioDeleted false -> true reports audio_delete once; true -> true reports nothing', async () => {
      await updateMeeting(id, { audioDeleted: true });
      expect(types()).toEqual(['meeting.audio_delete']);
      await updateMeeting(id, { audioDeleted: true });
      expect(types()).toEqual(['meeting.audio_delete']);
    });

    it('reports several changes of one patch, each once', async () => {
      await updateMeeting(id, { status: 'review', title: 'Nyt', participants: ['A', 'B'] });
      expect(types().sort()).toEqual(['meeting.participants_edit', 'meeting.rename', 'meeting.status_change']);
    });

    it('a missing meeting reports nothing', async () => {
      await updateMeeting('00000000-0000-4000-8000-000000000000', { status: 'review' });
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

describe('transcripts', () => {
  const base = { rawText: SECRET_TEXT, chapters: [], piiReplacements: [] };
  beforeEach(async () => {
    await saveTranscript('m1', { ...base, segments: [seg('a'), seg('b')] });
  });

  it('the initial transcription write (saveTranscript) never reports', () => {
    expect(h.report).not.toHaveBeenCalled();
  });

  it('a user edit of segments reports transcript_edit with the segment count only', async () => {
    await saveTranscriptSegments('m1', [seg(SECRET_TEXT, SECRET_NAME), seg('b'), seg('c')]);
    expect(calls()).toEqual([{ type: 'meeting.transcript_edit', entityId: 'm1', details: { segmentCount: 3 } }]);
    expectNoContent();
  });

  it('segments saved unchanged (flush on leave) report nothing', async () => {
    await saveTranscriptSegments('m1', [seg('a'), seg('b')]);
    expect(h.report).not.toHaveBeenCalled();
  });

  it('the automatic diarization pass is not a user edit', async () => {
    await saveTranscriptSegments('m1', [seg('a', 'Taler 2'), seg('b', 'Taler 1')], 'done');
    await saveTranscriptSegments('m1', [seg('a', 'Taler 3')], 'failed');
    expect(h.report).not.toHaveBeenCalled();
  });

  it('an explicit automatic flag suppresses reporting', async () => {
    await saveTranscriptSegments('m1', [seg('changed')], undefined, { automatic: true });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('a user edit of chapters reports transcript_edit without any chapter text', async () => {
    const chapters = [{ id: 'c1', title: SECRET_TITLE, startIndex: 0, endIndex: 1 }] as never;
    await saveTranscriptChapters('m1', chapters);
    expect(calls()).toEqual([{ type: 'meeting.transcript_edit', entityId: 'm1', details: undefined }]);
    expectNoContent();
  });

  it('generated chapters (automatic) and unchanged chapters report nothing', async () => {
    const chapters = [{ id: 'c1', title: 'x', startIndex: 0, endIndex: 1 }] as never;
    await saveTranscriptChapters('m1', chapters, { automatic: true });
    await saveTranscriptChapters('m1', chapters);
    expect(h.report).not.toHaveBeenCalled();
  });

  it('a missing transcript reports nothing', async () => {
    await saveTranscriptSegments('nope', [seg('x')]);
    await saveTranscriptChapters('nope', []);
    expect(h.report).not.toHaveBeenCalled();
  });
});

describe('minutes', () => {
  it('saveMinutes (autosave) reports minutes_save with no content, also on the first save', async () => {
    await saveMinutes('m1', minutes(SECRET_TEXT));
    await saveMinutes('m1', minutes('anden tekst'));
    expect(calls()).toEqual([
      { type: 'meeting.minutes_save', entityId: 'm1', details: { autosave: true } },
      { type: 'meeting.minutes_save', entityId: 'm1', details: { autosave: true } },
    ]);
    expectNoContent();
  });

  it('saveMinutes with identical content reports nothing', async () => {
    await saveMinutes('m1', minutes('x'));
    h.report.mockReset();
    await saveMinutes('m1', minutes('x'));
    expect(h.report).not.toHaveBeenCalled();
  });

  it('snapshotMinutes reports minutes_version with the new label; nothing when there is no row', async () => {
    expect(await snapshotMinutes('m1', minutes('x'))).toBeNull();
    expect(h.report).not.toHaveBeenCalled();
    await saveMinutes('m1', minutes('x'));
    h.report.mockReset();
    await snapshotMinutes('m1', minutes('y'));
    expect(calls()).toEqual([{ type: 'meeting.minutes_version', entityId: 'm1', details: { versionNumber: 2, action: 'snapshot' } }]);
    expectNoContent();
  });

  it('appendMinutesVersion reports minutes_version for the first and later generations', async () => {
    await appendMinutesVersion('m1', minutes('x'));
    await appendMinutesVersion('m1', minutes('y'));
    expect(calls().map((c) => c.details)).toEqual([
      { versionNumber: 1, action: 'generate' },
      { versionNumber: 2, action: 'generate' },
    ]);
    expectNoContent();
  });

  it('setActiveMinutesVersion reports only an actual switch, with the label of the activated version', async () => {
    await appendMinutesVersion('m1', minutes('x'));
    const row = await appendMinutesVersion('m1', minutes('y'));
    h.report.mockReset();
    const first = row.versions.find((v) => v.label === 1)!;
    await setActiveMinutesVersion('m1', first.id);
    expect(calls()).toEqual([{ type: 'meeting.minutes_version', entityId: 'm1', details: { versionNumber: 1, action: 'activate' } }]);
    await setActiveMinutesVersion('m1', first.id);
    await setActiveMinutesVersion('m1', 'unknown-version');
    expect(h.report).toHaveBeenCalledTimes(1);
  });
});

describe('contract with the server catalogue', () => {
  it('every event the storage layer reports passes the same validation the server applies', async () => {
    const m = await createMeeting({ title: SECRET_TITLE, participants: ['A'], origin: 'bot' });
    await updateMeeting(m.id, { status: 'review', title: 'Nyt', participants: ['A', 'B'], audioDeleted: true });
    await updateMeeting(m.id, { status: 'redacted' });
    await saveTranscript(m.id, { rawText: 't', chapters: [], piiReplacements: [], segments: [seg('a')] });
    await saveTranscriptSegments(m.id, [seg('b')]);
    await saveTranscriptChapters(m.id, [{ id: 'c', title: 't', startIndex: 0, endIndex: 0 }] as never);
    await saveMinutes(m.id, minutes('x'));
    await snapshotMinutes(m.id, minutes('y'));
    const row = await appendMinutesVersion(m.id, minutes('z'));
    await setActiveMinutesVersion(m.id, row.versions[0].id);
    await saveAudio(m.id, new Blob(['x']), 'audio/webm');
    await deleteAudio(m.id);
    await deleteMeeting(m.id);

    const seen = new Set(types());
    expect([...seen].sort()).toEqual([
      'meeting.audio_delete', 'meeting.create', 'meeting.delete', 'meeting.minutes_save', 'meeting.minutes_version',
      'meeting.participants_edit', 'meeting.redact', 'meeting.rename', 'meeting.status_change', 'meeting.transcript_edit',
    ]);
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

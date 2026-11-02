// Which storage operations report a client audit event, with what details, and
// that none of them ever carries content (titles, names, text): lifecycle (create,
// delete, redact, audio delete with its trigger), the participant list and speakers
// (counts), and the minutes (edit, versions, pruning). The reporter and the database
// are faked; the storage functions under test are the real ones.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MinutesContent, TranscriptSegment } from '@/types';
import { validateEvent } from '@/lib/audit/record';
import { reportAuditEvent } from '@/lib/audit/client';
import type { AuditEventInput } from '@/lib/audit/events';

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  stores: {} as Record<string, Map<string, Row>>,
  report: vi.fn(),
  /** Make every write / delete throw, to exercise the failure reports. */
  failPut: false,
  failDelete: false,
}));

const keyOf = (v: Row) => (v.id ?? v.meetingId) as string;

function fakeDb() {
  const s = h.stores;
  const byMeeting = (store: string, meetingId: string) => [...s[store].values()].filter((v) => v.meetingId === meetingId);
  const storeApi = (name: string) => ({
    delete: async (k: string) => {
      if (h.failDelete) throw new Error('delete failed');
      s[name].delete(k);
    },
    index: () => ({ getAll: async (q: string) => byMeeting(name, q) }),
  });
  return {
    get: async (store: string, k: string) => s[store].get(k),
    put: async (store: string, v: Row) => {
      if (h.failPut) throw new Error('disk full');
      s[store].set(keyOf(v), { ...v });
    },
    delete: async (store: string, k: string) => void s[store].delete(k),
    getAllFromIndex: async (store: string, _i: string, q: string) => byMeeting(store, q),
    // `store` is the single-store shorthand deleteAudio uses (audio only).
    transaction: () => ({
      objectStore: storeApi,
      store: { getKey: async (k: string) => (s.audio.has(k) ? k : undefined), delete: storeApi('audio').delete },
      get done() {
        return h.failDelete ? Promise.reject(new Error('delete failed')) : Promise.resolve();
      },
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

const calls = () => h.report.mock.calls.map(([type, entityId, details, opts]) => ({ type, entityId, details, outcome: opts?.outcome }));
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
  h.failPut = false;
  h.failDelete = false;
});

describe('meetings', () => {
  it('createMeeting reports nothing (the creation is marked by recording_start, audio.upload or teams.meeting_register)', async () => {
    await createMeeting({ title: SECRET_TITLE, participants: [SECRET_NAME], status: 'processing' });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('createMeeting still creates the meeting when reporting is silent', async () => {
    const m = await createMeeting({ title: 'x' });
    expect(h.stores.meetings.get(m.id)?.title).toBe('x');
  });

  describe('updateMeeting', () => {
    let id: string;
    beforeEach(async () => {
      id = (await createMeeting({ title: SECRET_TITLE, participants: [SECRET_NAME], status: 'recording' })).id;
      h.report.mockReset();
    });

    it('reports nothing for status changes, renames and other patches', async () => {
      await updateMeeting(id, { status: 'processing' });
      await updateMeeting(id, { status: 'review', title: 'Et helt andet navn om Hansen' });
      await updateMeeting(id, { audioSizeBytes: 10, audioDurationSeconds: 5 });
      expect(h.report).not.toHaveBeenCalled();
    });

    it('a changed participant list reports metadata_edit (participants) with the COUNT only; a repeat, a machine write or no change report nothing', async () => {
      await updateMeeting(id, { participants: [SECRET_NAME, 'A', 'B'] });
      expect(calls()).toEqual([{ type: 'meeting.metadata_edit', entityId: id, details: { field: 'participants', count: 3 } }]);
      expectNoContent();
      h.report.mockClear();
      await updateMeeting(id, { participants: [SECRET_NAME, 'A', 'B'] }); // the mount effect re-saving the same list
      await updateMeeting(id, { participants: ['X'] }, { automatic: true }); // the Teams roster sync
      await updateMeeting(id, { status: 'review' });
      expect(h.report).not.toHaveBeenCalled();
    });

    it('status becoming redacted reports only the audio delete when the audio went too (the transcript text is its own event), no redact and no status_change', async () => {
      await updateMeeting(id, { status: 'redacted', audioDeleted: true });
      expect(calls()).toEqual([{ type: 'meeting.audio_delete', entityId: id, details: { trigger: 'user' } }]);
      expectNoContent();
      h.report.mockClear();
      await updateMeeting(id, { status: 'redacted' });
      expect(h.report).not.toHaveBeenCalled();
    });

    it('a text edit reports transcript_edit (no details), a pure text edit never a speakers edit', async () => {
    await saveTranscript('m1', { rawText: 't', chapters: [], piiReplacements: [], segments: [seg('a'), seg('b', 'Taler 2')] });
    await saveTranscriptSegments('m1', [seg(SECRET_TEXT), seg('b', 'Taler 2')]);
    expect(calls()).toEqual([{ type: 'meeting.transcript_edit', entityId: 'm1', details: undefined }]);
    expectNoContent();
  });

  it('detects a speaker change even when the segment count differs (merged, split or removed segments)', async () => {
    const count = (v: unknown) => (v as { count: number }).count;
    await saveTranscript('m1', { rawText: 't', chapters: [], piiReplacements: [], segments: [seg('a'), seg('b', 'Taler 2'), seg('c')] });
    // Segment 1 and 2 merged into one for Taler 2, speakers changed: 3 segments -> 2.
    await saveTranscriptSegments('m1', [seg('a b', 'Taler 2'), seg('c')]);
    expect(calls().filter((c) => c.type === 'meeting.metadata_edit').map((c) => count(c.details))).toEqual([2]);
    h.report.mockClear();
    // Splitting one speaker's segment in two keeps the speaker sequence: not a speaker edit.
    await saveTranscriptSegments('m1', [seg('a', 'Taler 2'), seg('b', 'Taler 2'), seg('c')]);
    expect(types()).toEqual([]);
    h.report.mockClear();
    // A voice relabelled across a changed number of segments is one.
    await saveTranscriptSegments('m1', [seg('ab', SECRET_NAME), seg('c')]);
    expect(types().filter((t) => t === 'meeting.metadata_edit')).toEqual(['meeting.metadata_edit']);
    expectNoContent();
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

    it('passes an automatic trigger through to audio_delete', async () => {
      await updateMeeting(id, { audioDeleted: true }, { trigger: 'auto_leave' });
      expect(calls()).toEqual([{ type: 'meeting.audio_delete', entityId: id, details: { trigger: 'auto_leave' } }]);
    });

    it('a missing meeting reports nothing', async () => {
      await updateMeeting('00000000-0000-4000-8000-000000000000', { status: 'redacted' });
      expect(h.report).not.toHaveBeenCalled();
    });
  });

  describe('deleteMeeting', () => {
    it('reports meeting.delete once, after the data is gone', async () => {
      const m = await createMeeting({ title: SECRET_TITLE });
      h.report.mockImplementation(() => expect(h.stores.meetings.has(m.id)).toBe(false));
      h.report.mockClear();
      await deleteMeeting(m.id);
      expect(calls()).toEqual([{ type: 'meeting.delete', entityId: m.id, details: { trigger: 'user' } }]);
    });

    it('says when the app deleted the meeting on its own', async () => {
      const m = await createMeeting({ title: 'x' });
      h.report.mockClear();
      await deleteMeeting(m.id, { trigger: 'auto_empty' });
      expect(calls()).toEqual([{ type: 'meeting.delete', entityId: m.id, details: { trigger: 'auto_empty' } }]);
    });

    it('reports nothing for a meeting that does not exist (repeat delete)', async () => {
      await deleteMeeting('00000000-0000-4000-8000-000000000000');
      expect(h.report).not.toHaveBeenCalled();
    });

    it('an automatic delete is reported before anything is awaited and retracted when the meeting did not exist', async () => {
      const retract = vi.fn();
      h.report.mockReturnValue(retract);
      const m = await createMeeting({ title: 'x' });
      h.report.mockClear();
      const pending = deleteMeeting(m.id, { trigger: 'auto_pagehide' });
      expect(calls()).toEqual([{ type: 'meeting.delete', entityId: m.id, details: { trigger: 'auto_pagehide' } }]);
      await pending;
      expect(retract).not.toHaveBeenCalled();
      await deleteMeeting(m.id, { trigger: 'auto_pagehide' }); // already gone
      expect(retract).toHaveBeenCalledTimes(1);
    });
  });
});

describe('audio', () => {
  it('deleteAudio reports meeting.audio_delete when audio existed', async () => {
    await saveAudio('m1', new Blob(['x']), 'audio/webm');
    await deleteAudio('m1');
    expect(calls()).toEqual([{ type: 'meeting.audio_delete', entityId: 'm1', details: { trigger: 'user' } }]);
  });

  it.each(['auto_generate', 'auto_leave', 'auto_pagehide'] as const)('deleteAudio reports the automatic trigger %s', async (trigger) => {
    await saveAudio('m1', new Blob(['x']), 'audio/webm');
    await deleteAudio('m1', { trigger });
    expect(calls()).toEqual([{ type: 'meeting.audio_delete', entityId: 'm1', details: { trigger } }]);
  });

  it('an automatic delete is reported in the same tick as the delete request, before anything is awaited', async () => {
    await saveAudio('m1', new Blob(['x']), 'audio/webm');
    const pending = deleteAudio('m1', { trigger: 'auto_pagehide' });
    expect(calls()).toEqual([{ type: 'meeting.audio_delete', entityId: 'm1', details: { trigger: 'auto_pagehide' } }]);
    await pending;
    expect(h.report).toHaveBeenCalledTimes(1);
  });

  it('an automatic delete with no audio left retracts the event it reported early; a user delete never reports early', async () => {
    const retract = vi.fn();
    h.report.mockReturnValue(retract);
    await deleteAudio('m1', { trigger: 'auto_leave' });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(retract).toHaveBeenCalledTimes(1);
    h.report.mockClear();
    const pending = deleteAudio('m1');
    expect(h.report).not.toHaveBeenCalled();
    await pending;
    expect(h.report).not.toHaveBeenCalled();
  });

  it('reports nothing when there was no audio, and saving audio reports nothing', async () => {
    await deleteAudio('m1');
    await saveAudio('m1', new Blob(['x']), 'audio/webm');
    expect(h.report).not.toHaveBeenCalled();
  });
});

describe('transcripts', () => {
  it('reports metadata_edit/speakers (a count) only when who spoke changed by a user; diarization, chapters and an unchanged re-save report nothing', async () => {
    await saveTranscript('m1', { rawText: SECRET_TEXT, chapters: [], piiReplacements: [], segments: [seg('a'), seg('b', 'Taler 2')] });
    expect(h.report).not.toHaveBeenCalled();

    await saveTranscriptSegments('m1', [seg('a'), seg('b', 'Taler 2')]); // the mount effect re-saving what is stored
    await saveTranscriptSegments('m1', [seg('a', 'Taler 3')], 'done'); // diarization pass (different length too)
    await saveTranscriptChapters('m1', [{ id: 'c1', title: SECRET_TITLE, startIndex: 0, endIndex: 1 }] as never);
    expect(h.report).not.toHaveBeenCalled();

    await saveTranscript('m1', { rawText: 't', chapters: [], piiReplacements: [], segments: [seg('a'), seg('b', 'Taler 2')] });
    await saveTranscriptSegments('m1', [seg('a', SECRET_NAME), seg('b', 'Taler 2')]); // a voice linked to a person
    expect(calls()).toEqual([{ type: 'meeting.metadata_edit', entityId: 'm1', details: { field: 'speakers', count: 2 } }]);
    expectNoContent();

    h.report.mockClear();
    await saveTranscriptSegments('m1', [seg('a', SECRET_NAME), seg('b', 'Taler 2')]); // same speakers again
    expect(h.report).not.toHaveBeenCalled();
  });

  it('a throwing reporter never fails the write', async () => {
    await saveTranscript('m1', { rawText: 't', chapters: [], piiReplacements: [], segments: [seg('a')] });
    h.report.mockImplementation(() => {
      throw new Error('reporter down');
    });
    await expect(saveTranscriptSegments('m1', [seg('a', 'Taler 2')])).resolves.toBeUndefined();
    expect(h.stores.transcripts.size).toBe(1);
  });
});

describe('minutes', () => {
  it('the first save and every changed autosave report minutes_save; identical content (closing the editor) reports nothing', async () => {
    await saveMinutes('m1', minutes(SECRET_TEXT));
    expect(types()).toEqual(['meeting.minutes_save']);
    await saveMinutes('m1', minutes(SECRET_TEXT));
    expect(types()).toEqual(['meeting.minutes_save']);
    await saveMinutes('m1', minutes('anden tekst'));
    expect(types()).toEqual(['meeting.minutes_save', 'meeting.minutes_save']);
    expectNoContent();
  });

  it('"Gem version" and regeneration report minutes_version with the version label, never content', async () => {
    await saveMinutes('m1', minutes('a'));
    h.report.mockClear();
    await snapshotMinutes('m1', minutes('y'));
    await appendMinutesVersion('m1', minutes('x'));
    expect(calls()).toEqual([
      { type: 'meeting.minutes_version', entityId: 'm1', details: { versionNumber: 2, action: 'snapshot' } },
      { type: 'meeting.minutes_version', entityId: 'm1', details: { versionNumber: 3, action: 'generate' } },
    ]);
    expectNoContent();
  });

  it('the very first generation is version 1', async () => {
    await appendMinutesVersion('m1', minutes('x'));
    expect(calls()).toEqual([{ type: 'meeting.minutes_version', entityId: 'm1', details: { versionNumber: 1, action: 'generate' } }]);
  });

  it('switching to an earlier version is ONE restore row; back to the newest or to the active one reports nothing', async () => {
    await appendMinutesVersion('m1', minutes('one'));
    const row = await appendMinutesVersion('m1', minutes('two'));
    h.report.mockClear();
    await setActiveMinutesVersion('m1', row.versions[0].id); // version 1 of 2
    expect(calls().map((c) => c.details)).toEqual([{ versionNumber: 1, action: 'restore' }]);
    h.report.mockClear();
    await setActiveMinutesVersion('m1', row.versions[1].id); // back to the newest
    expect(h.report).not.toHaveBeenCalled(); // exposes no older content
    h.report.mockClear();
    await setActiveMinutesVersion('m1', row.versions[1].id); // already active
    await setActiveMinutesVersion('m1', 'not-a-version');
    expect(h.report).not.toHaveBeenCalled();
  });

  it('reports minutes_version_prune with the number of versions the 50-version cap removed', async () => {
    for (let i = 0; i < 50; i++) await appendMinutesVersion('m1', minutes(`v${i}`));
    expect(types().filter((t) => t === 'meeting.minutes_version_prune')).toEqual([]);
    await appendMinutesVersion('m1', minutes('51'));
    expect(calls().filter((c) => c.type === 'meeting.minutes_version_prune')).toEqual([
      { type: 'meeting.minutes_version_prune', entityId: 'm1', details: { prunedCount: 1 } },
    ]);
    await snapshotMinutes('m1', minutes('52'));
    expect(types().filter((t) => t === 'meeting.minutes_version_prune')).toHaveLength(2);
  });
});

describe('contract with the server catalogue', () => {
  it('every event the storage layer reports passes the same validation the server applies', async () => {
    const m = await createMeeting({ title: SECRET_TITLE, participants: ['A'] });
    await updateMeeting(m.id, { status: 'review', title: 'Nyt', participants: ['A', 'B'], audioDeleted: true });
    await updateMeeting(m.id, { status: 'redacted' });
    await saveTranscript(m.id, { rawText: 't', chapters: [], piiReplacements: [], segments: [seg('a')] });
    await saveMinutes(m.id, minutes('x'));
    await saveAudio(m.id, new Blob(['x']), 'audio/webm');
    await saveMinutes(m.id, minutes('y'));
    await snapshotMinutes(m.id, minutes('z'));
    const row = await appendMinutesVersion(m.id, minutes('w'));
    await setActiveMinutesVersion(m.id, row.versions[0].id);
    for (let i = 0; i < 50; i++) await appendMinutesVersion(m.id, minutes(`v${i}`));
    await saveTranscriptSegments(m.id, [seg('a', SECRET_NAME)]);
    await saveTranscriptSegments(m.id, [seg('andet', SECRET_NAME)]);
    await saveTranscript(m.id, { rawText: '', chapters: [], piiReplacements: [], segments: [] }); // redaction blanks the text
    await updateMeeting(m.id, { recordedAt: '2026-01-01T00:00:00.000Z' });
    reportAuditEvent('meeting.metadata_edit', m.id, { field: 'title' });
    await updateMeeting(m.id, { participants: ['A', 'B', 'C'] });
    await deleteAudio(m.id);
    await deleteMeeting(m.id);


    const seen = new Set(types());
    expect([...seen].sort()).toEqual([
      'meeting.audio_delete',
      'meeting.delete',
      'meeting.metadata_edit',
      'meeting.minutes_save',
      'meeting.minutes_version',
      'meeting.minutes_version_prune',
      'meeting.transcript_delete',
      'meeting.transcript_edit',
    ]);
    for (const c of calls()) {
      const result = validateEvent({
        type: c.type,
        source: 'client',
        actorUserId: 'user-1',
        entityId: '11111111-2222-4333-8444-555555555555',
        details: c.details ?? {},
        ...(c.outcome ? { outcome: c.outcome } : {}),
      } as AuditEventInput);
      expect(result, `${c.type} ${JSON.stringify(c.details)}`).toMatchObject({ ok: true });
    }
    expectNoContent();
  });
});

describe('failed writes are reported with outcome error', () => {
  it('a failed minutes autosave is minutes_save/error (and never a success); an unchanged autosave that fails reports nothing', async () => {
    await saveMinutes('m1', minutes('one'));
    h.report.mockClear();
    h.failPut = true;
    await expect(saveMinutes('m1', minutes('two'))).rejects.toThrow('disk full');
    expect(calls()).toEqual([{ type: 'meeting.minutes_save', entityId: 'm1', details: undefined, outcome: 'error' }]);
    h.report.mockClear();
    await expect(saveMinutes('m1', minutes('one'))).rejects.toThrow();
    expect(h.report).not.toHaveBeenCalled();
    expectNoContent();
  });

  it('a failed "Gem version", regeneration and version switch are minutes_version/error with the label', async () => {
    await appendMinutesVersion('m1', minutes('one'));
    const row = await appendMinutesVersion('m1', minutes('two'));
    h.report.mockClear();
    h.failPut = true;
    await expect(snapshotMinutes('m1', minutes('three'))).rejects.toThrow();
    await expect(appendMinutesVersion('m1', minutes('four'))).rejects.toThrow();
    await expect(setActiveMinutesVersion('m1', row.versions[0].id)).rejects.toThrow();
    expect(calls().map((c) => [c.details, c.outcome])).toEqual([
      [{ versionNumber: 3, action: 'snapshot' }, 'error'],
      [{ versionNumber: 3, action: 'generate' }, 'error'],
      [{ versionNumber: 1, action: 'restore' }, 'error'],
    ]);
    expectNoContent();
  });

  it('a failed first generation is generate/error for version 1', async () => {
    h.failPut = true;
    await expect(appendMinutesVersion('m1', minutes('x'))).rejects.toThrow();
    expect(calls()).toEqual([
      { type: 'meeting.minutes_version', entityId: 'm1', details: { versionNumber: 1, action: 'generate' }, outcome: 'error' },
    ]);
  });

  it('a failed transcript text / speaker edit is reported as failed; a failed machine write reports nothing', async () => {
    await saveTranscript('m1', { rawText: 't', chapters: [], piiReplacements: [], segments: [seg('a'), seg('b', 'Taler 2')] });
    h.report.mockClear();
    h.failPut = true;
    await expect(saveTranscriptSegments('m1', [seg(SECRET_TEXT, SECRET_NAME), seg('b', 'Taler 2')])).rejects.toThrow();
    expect(calls().map((c) => [c.type, c.outcome])).toEqual([
      ['meeting.metadata_edit', 'error'],
      ['meeting.transcript_edit', 'error'],
    ]);
    expectNoContent();
    h.report.mockClear();
    await expect(saveTranscriptSegments('m1', [seg('z')], 'done')).rejects.toThrow();
    expect(h.report).not.toHaveBeenCalled();
  });

  it('a failed meeting write reports what it would have: recording date and participants as error, never the audio flag', async () => {
    const id = (await createMeeting({ title: 'x', participants: ['A'], status: 'recording' })).id;
    h.report.mockClear();
    h.failPut = true;
    await expect(
      updateMeeting(id, { status: 'redacted', audioDeleted: true, recordedAt: '2026-01-01T00:00:00.000Z', participants: ['A', 'B'] }),
    ).rejects.toThrow();
    expect(calls().map((c) => [c.type, c.outcome])).toEqual([
      ['meeting.metadata_edit', 'error'],
      ['meeting.metadata_edit', 'error'],
    ]);
  });
});

describe('transcript deletion (redaction)', () => {
  it('blanking a transcript that had text reports meeting.transcript_delete once, without content; blanking an empty one reports nothing', async () => {
    await saveTranscript('m1', { rawText: SECRET_TEXT, chapters: [], piiReplacements: [], segments: [seg(SECRET_TEXT)] });
    h.report.mockClear();
    await saveTranscript('m1', { rawText: '', chapters: [], piiReplacements: [], segments: [], piiRemovedAt: '2026-01-01T00:00:00.000Z' });
    expect(calls()).toEqual([{ type: 'meeting.transcript_delete', entityId: 'm1', details: undefined, outcome: undefined }]);
    expectNoContent();
    h.report.mockClear();
    await saveTranscript('m1', { rawText: '', chapters: [], piiReplacements: [], segments: [] });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('a failed redaction write reports transcript_delete as error', async () => {
    await saveTranscript('m1', { rawText: 't', chapters: [], piiReplacements: [], segments: [seg('a')] });
    h.report.mockClear();
    h.failPut = true;
    await expect(saveTranscript('m1', { rawText: '', chapters: [], piiReplacements: [], segments: [] })).rejects.toThrow();
    expect(calls()).toEqual([{ type: 'meeting.transcript_delete', entityId: 'm1', details: undefined, outcome: 'error' }]);
  });
});

describe('failed deletes', () => {
  it('a user-asked delete that throws reports error; one that finds nothing reports nothing', async () => {
    const id = (await createMeeting({ title: 'x' })).id;
    h.report.mockClear();
    h.failDelete = true;
    await expect(deleteMeeting(id)).rejects.toThrow();
    expect(calls()).toEqual([{ type: 'meeting.delete', entityId: id, details: { trigger: 'user' }, outcome: 'error' }]);
    h.report.mockClear();
    h.failDelete = false;
    await deleteMeeting('00000000-0000-4000-8000-000000000000'); // never existed
    expect(h.report).not.toHaveBeenCalled();
  });

  it('an audio delete that throws reports error for the user trigger too', async () => {
    await saveAudio('m1', new Blob(['x']), 'audio/webm');
    h.report.mockClear();
    h.failDelete = true;
    await expect(deleteAudio('m1')).rejects.toThrow();
    expect(calls()).toEqual([{ type: 'meeting.audio_delete', entityId: 'm1', details: { trigger: 'user' }, outcome: 'error' }]);
  });
});

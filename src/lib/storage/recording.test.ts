import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDB } from 'idb';
import { setStorageUserId } from './scope';
import { getDB } from './db';
import { createMeeting, getMeeting, deleteMeeting } from './meetings';
import { getTranscript } from './transcripts';
import {
  putBatch,
  completeBatch,
  markAttempt,
  listBatches,
  getPendingAudio,
  getRecordingSummary,
  listMeetingIdsWithRecordingState,
  sweepExpiredPendingAudio,
  finalizeRecordingToTranscript,
  PENDING_AUDIO_TTL_MS,
} from './recording';

// Each test runs against its own user's database, so nothing leaks between tests.
let userId: string;
beforeEach(() => {
  userId = crypto.randomUUID();
  setStorageUserId(userId);
});
afterEach(() => {
  vi.useRealTimers();
});

const wav = (bytes = 4) => new Uint8Array(bytes).fill(7).buffer;

function batch(meetingId: string, seq: number, start: number, end: number, session = 0) {
  return {
    meetingId,
    seq,
    session,
    status: 'pending' as const,
    intervals: [{ originalStart: start, originalEnd: end, wavOffset: 0, wavDuration: end - start }],
    totalWavDuration: end - start,
  };
}

const seg = (text: string, start: number, end: number) => ({ speaker: 'Taler 1', start, end, text });

describe('IndexedDB upgrade from v1', () => {
  it('keeps existing meetings and adds the recording stores', async () => {
    const v1 = await openDB(`referat-db-u-${userId}`, 1, {
      upgrade(db) {
        db.createObjectStore('meetings', { keyPath: 'id' });
        db.createObjectStore('transcripts', { keyPath: 'id' }).createIndex('by-meeting', 'meetingId');
        db.createObjectStore('minutes', { keyPath: 'id' }).createIndex('by-meeting', 'meetingId');
        db.createObjectStore('audio', { keyPath: 'meetingId' });
      },
    });
    await v1.put('meetings', { id: 'old', title: 'Gammelt møde', createdAt: '2024-01-01T00:00:00.000Z' });
    v1.close();

    expect(await getMeeting('old')).toMatchObject({ title: 'Gammelt møde' });
    await putBatch(batch('old', 0, 0, 27), wav());
    expect(await listBatches('old')).toHaveLength(1);
  });

  it('closes its connection when another tab opens a newer version', async () => {
    await getDB();
    const newer = await openDB(`referat-db-u-${userId}`, 3);
    expect(newer.version).toBe(3);
    newer.close();
  });
});

describe('createMeeting', () => {
  it('stores the kind it is given', async () => {
    const note = await createMeeting({ title: 'Note', kind: 'note' });
    expect((await getMeeting(note.id))?.kind).toBe('note');
  });

  it('leaves kind off a meeting created without one', async () => {
    const m = await createMeeting({ title: 'Møde' });
    expect('kind' in m).toBe(false);
  });
});

describe('putBatch', () => {
  it('stores the row and its audio with a 24 h expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T10:00:00.000Z'));
    await putBatch(batch('m', 0, 0, 27), wav());

    const [row] = await listBatches('m');
    expect(row).toMatchObject({ status: 'pending', attempts: 0, segments: null });
    expect(new Uint8Array((await getPendingAudio('m', 0))!)).toEqual(new Uint8Array(wav()));
    const db = await getDB();
    const audio = await db.get('pendingAudio', ['m', 0]);
    expect(Date.parse(audio!.expiresAt) - Date.parse(audio!.createdAt)).toBe(PENDING_AUDIO_TTL_MS);
  });

  it('rewrites an open checkpoint and keeps its attempt count', async () => {
    await putBatch({ ...batch('m', 0, 0, 10), status: 'open' }, wav(2));
    await markAttempt('m', 0);
    await putBatch(batch('m', 0, 0, 27), wav(8));

    const [row] = await listBatches('m');
    expect(row).toMatchObject({ status: 'pending', attempts: 1, totalWavDuration: 27 });
    expect((await getPendingAudio('m', 0))!.byteLength).toBe(8);
  });
});

describe('completeBatch', () => {
  it('writes the segments and deletes the audio together', async () => {
    await putBatch(batch('m', 0, 0, 27), wav());
    await completeBatch(batch('m', 0, 0, 27), [seg('hej', 0, 2)]);

    const [row] = await listBatches('m');
    expect(row).toMatchObject({ status: 'done', segments: [seg('hej', 0, 2)] });
    expect(await getPendingAudio('m', 0)).toBeNull();
  });

  it('stores the text of a batch IndexedDB refused to store when it was sealed', async () => {
    const m = await createMeeting({ title: 'Møde' });
    await completeBatch(batch(m.id, 0, 0, 27), [seg('hej', 0, 2)]);

    const [row] = await listBatches(m.id);
    expect(row).toMatchObject({ status: 'done', segments: [seg('hej', 0, 2)], totalWavDuration: 27 });
  });

  it('does not bring back a batch whose meeting was deleted meanwhile', async () => {
    await putBatch(batch('m', 0, 0, 27), wav());
    await deleteMeeting('m');
    await completeBatch(batch('m', 0, 0, 27), [seg('hej', 0, 2)]);
    expect(await listBatches('m')).toEqual([]);
  });
});

describe('sweepExpiredPendingAudio', () => {
  it('deletes expired audio and marks its batch lost, leaving fresh audio alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T10:00:00.000Z'));
    await putBatch(batch('m', 0, 0, 27), wav());
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    await putBatch(batch('m', 1, 27, 54), wav());

    vi.setSystemTime(new Date(Date.parse('2026-01-01T10:00:00.000Z') + PENDING_AUDIO_TTL_MS + 1));
    await sweepExpiredPendingAudio();

    expect((await listBatches('m')).map((b) => b.status)).toEqual(['lost', 'pending']);
    expect(await getPendingAudio('m', 0)).toBeNull();
    expect(await getPendingAudio('m', 1)).not.toBeNull();
  });
});

describe('getRecordingSummary / listMeetingIdsWithRecordingState', () => {
  it('derives the session state from the rows', async () => {
    await putBatch(batch('m', 0, 0, 27), wav());
    await completeBatch(batch('m', 0, 0, 27), [seg('hej', 0, 2)]);
    await putBatch(batch('m', 1, 27, 54, 1), wav());
    await putBatch(batch('other', 0, 0, 5), wav());

    expect(await getRecordingSummary('m')).toEqual({ nextSeq: 2, nextSession: 2, timelineEnd: 54 });
    expect(await getRecordingSummary('none')).toBeNull();
    expect((await listMeetingIdsWithRecordingState()).sort()).toEqual(['m', 'other']);
  });
});

describe('finalizeRecordingToTranscript', () => {
  it('writes the transcript with lost batches as marker lines, sets review and deletes the ledger', async () => {
    const m = await createMeeting({ title: 'Møde' });
    await putBatch(batch(m.id, 0, 0, 27), wav());
    await completeBatch(batch(m.id, 0, 0, 27), [seg('hej', 1, 2)]);
    await putBatch(batch(m.id, 1, 27, 754), wav());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + PENDING_AUDIO_TTL_MS + 1);
    await sweepExpiredPendingAudio();
    vi.useRealTimers();
    await putBatch(batch(m.id, 2, 754, 760), wav());
    await completeBatch(batch(m.id, 2, 0, 27), [seg('farvel', 755, 756)]);

    const written = await finalizeRecordingToTranscript(m.id, { diarizationStatus: 'pending' });

    const marker = {
      speaker: 'Taler 1', start: 27, end: 754,
      text: '[Lyden fra 00:27 til 12:34 kunne ikke transskriberes]',
    };
    expect(written).toEqual([seg('hej', 1, 2), marker, seg('farvel', 755, 756)]);
    expect(await getTranscript(m.id)).toMatchObject({
      segments: written,
      rawText: `hej ${marker.text} farvel`,
      diarizationStatus: 'pending',
    });
    expect((await getMeeting(m.id))?.status).toBe('review');
    expect(await listBatches(m.id)).toEqual([]);
    expect(await getPendingAudio(m.id, 1)).toBeNull();
  });

  it('is idempotent: a second call finds no rows and changes nothing', async () => {
    const m = await createMeeting({ title: 'Møde' });
    await putBatch(batch(m.id, 0, 0, 27), wav());
    await completeBatch(batch(m.id, 0, 0, 27), [seg('hej', 1, 2)]);
    await finalizeRecordingToTranscript(m.id, { diarizationStatus: 'pending' });
    const first = await getTranscript(m.id);

    expect(await finalizeRecordingToTranscript(m.id, { diarizationStatus: 'done' })).toBeNull();
    expect(await getTranscript(m.id)).toEqual(first);
  });

  it('marks a batch that never got transcribed and drops its audio', async () => {
    const m = await createMeeting({ title: 'Møde' });
    await putBatch(batch(m.id, 0, 0, 27), wav());

    const written = await finalizeRecordingToTranscript(m.id, { diarizationStatus: 'done' });

    expect(written).toEqual([
      { speaker: 'Taler 1', start: 0, end: 27, text: '[Lyden fra 00:00 til 00:27 kunne ikke transskriberes]' },
    ]);
    expect(await getPendingAudio(m.id, 0)).toBeNull();
  });
});

describe('deleteMeeting', () => {
  it('clears the ledger and the pending audio', async () => {
    const m = await createMeeting({ title: 'Møde' });
    await putBatch(batch(m.id, 0, 0, 27), wav());
    await putBatch(batch(m.id, 1, 27, 54), wav());
    await putBatch(batch('other', 0, 0, 27), wav());

    await deleteMeeting(m.id);

    expect(await listBatches(m.id)).toEqual([]);
    expect(await getPendingAudio(m.id, 0)).toBeNull();
    expect(await getPendingAudio(m.id, 1)).toBeNull();
    expect(await listBatches('other')).toHaveLength(1);
    expect(await getPendingAudio('other', 0)).not.toBeNull();
  });
});

// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setStorageUserId } from '@/lib/storage/scope';
import { createMeeting, getMeeting } from '@/lib/storage/meetings';
import { getTranscript } from '@/lib/storage/transcripts';
import { putBatch, completeBatch, listBatches, getPendingAudio, finalizeRecordingToTranscript } from '@/lib/storage/recording';
import { getBatchQueue } from './batch-queue';
import { finishRecording } from './finish';

let meetingId: string;
beforeEach(async () => {
  setStorageUserId(crypto.randomUUID());
  meetingId = (await createMeeting({ title: 'Møde' })).id;
  // Requests never answer, so nothing the queue holds gets transcribed by itself.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const wav = () => new Uint8Array(8).fill(1).buffer;
const batch = (seq: number) => ({
  meetingId,
  seq,
  session: 0,
  status: 'pending' as const,
  intervals: [{ originalStart: seq * 27, originalEnd: seq * 27 + 27, wavOffset: 0, wavDuration: 27 }],
  totalWavDuration: 27,
});
const seg = (text: string, start: number) => ({ speaker: 'Taler 1', start, end: start + 5, text });

describe('finishRecording', () => {
  it('saves the transcript when every batch has its text', async () => {
    await putBatch(batch(0), wav());
    await completeBatch(meetingId, 0, [seg('Hej.', 0)]);
    await putBatch(batch(1), wav());
    await completeBatch(meetingId, 1, [seg('Farvel.', 27)]);

    expect(await finishRecording(meetingId)).toBe('saved');

    expect((await getTranscript(meetingId))?.segments.map((s) => s.text)).toEqual(['Hej.', 'Farvel.']);
    expect((await getTranscript(meetingId))?.diarizationStatus).toBe('pending');
    expect((await getMeeting(meetingId))?.status).toBe('review');
    expect(await listBatches(meetingId)).toEqual([]);
  });

  it('waits, and marks the meeting processing, while a batch is still untranscribed', async () => {
    await putBatch(batch(0), wav());
    await completeBatch(meetingId, 0, [seg('Hej.', 0)]);
    await putBatch(batch(1), wav());

    expect(await finishRecording(meetingId)).toBe('waiting');

    expect((await getMeeting(meetingId))?.status).toBe('processing');
    expect(await getTranscript(meetingId)).toBeNull();
    expect((await listBatches(meetingId)).map((r) => r.status)).toEqual(['done', 'pending']);
    expect(await getPendingAudio(meetingId, 1)).not.toBeNull();
  });

  it('waits for a batch the queue holds only in memory because IndexedDB refused it', async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    await getBatchQueue(meetingId).enqueue({ ...batch(0), wav: wav() });
    put.mockRestore();
    expect(await listBatches(meetingId)).toEqual([]);

    expect(await finishRecording(meetingId)).toBe('waiting');
    expect((await getMeeting(meetingId))?.status).toBe('processing');
  });

  it('reports saved, and keeps the transcript, when RecordingRecovery finalised the ledger first', async () => {
    await putBatch(batch(0), wav());
    await completeBatch(meetingId, 0, [seg('Hej.', 0)]);
    await finalizeRecordingToTranscript(meetingId, { diarizationStatus: 'done' });

    expect(await finishRecording(meetingId)).toBe('saved');

    expect(await getMeeting(meetingId)).not.toBeNull();
    expect((await getTranscript(meetingId))?.segments.map((s) => s.text)).toEqual(['Hej.']);
  });

  it.each([
    ['no batch at all', async () => {}],
    ['only batches without speech', async () => {
      await putBatch(batch(0), wav());
      await completeBatch(meetingId, 0, []);
    }],
  ])('reports empty and deletes the meeting when there is %s', async (_case, seed) => {
    await seed();

    expect(await finishRecording(meetingId)).toBe('empty');

    expect(await getMeeting(meetingId)).toBeNull();
    expect(await getTranscript(meetingId)).toBeNull();
    expect(await listBatches(meetingId)).toEqual([]);
  });
});

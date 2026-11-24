// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setStorageUserId } from '@/lib/storage/scope';
import { createMeeting, getMeeting, updateMeeting } from '@/lib/storage/meetings';
import { saveAudio, getAudio } from '@/lib/storage/audio';
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
    await completeBatch(batch(0), [seg('Hej.', 0)]);
    await putBatch(batch(1), wav());
    await completeBatch(batch(1), [seg('Farvel.', 27)]);

    expect(await finishRecording(meetingId)).toBe('saved');

    expect((await getTranscript(meetingId))?.segments.map((s) => s.text)).toEqual(['Hej.', 'Farvel.']);
    expect((await getMeeting(meetingId))?.status).toBe('review');
    expect(await listBatches(meetingId)).toEqual([]);
  });

  // Regression: whoever settled the recording first decided alone whether it had audio.
  it.each([
    ['stored audio', async () => { await saveAudio(meetingId, new Blob(['lyd']), 'audio/webm'); }, 'pending', false],
    ['no audio', async () => {}, 'done', true],
  ] as const)('with %s, diarization is %s and audioDeleted %s', async (_case, seed, diarizationStatus, audioDeleted) => {
    await seed();
    await putBatch(batch(0), wav());
    await completeBatch(batch(0), [seg('Hej.', 0)]);

    expect(await finishRecording(meetingId)).toBe('saved');

    expect((await getTranscript(meetingId))?.diarizationStatus).toBe(diarizationStatus);
    expect((await getMeeting(meetingId))?.audioDeleted).toBe(audioDeleted);
  });

  // Regression: a resumed session's speakers were marked done while its screen still diarized them.
  it('leaves the speakers pending for a caller that diarizes audio it did not store, also when the drain watcher settles', async () => {
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    await putBatch(batch(0), wav());

    expect(await finishRecording(meetingId, { diarizing: true })).toBe('waiting');
    answer(new Response(JSON.stringify({ text: 'Hej.' }), { status: 200 }));

    await vi.waitFor(async () => expect((await getMeeting(meetingId))?.status).toBe('review'));
    expect((await getTranscript(meetingId))?.diarizationStatus).toBe('pending');
    expect((await getMeeting(meetingId))?.audioDeleted).toBe(true);
  });

  // Regression: a stale settle sent a meeting that had moved on back to review and deleted its audio.
  it('leaves a meeting that has moved on past review alone', async () => {
    await putBatch(batch(0), wav());
    await completeBatch(batch(0), [seg('Hej.', 0)]);
    await finishRecording(meetingId);
    await saveAudio(meetingId, new Blob(['lyd']), 'audio/webm');
    await updateMeeting(meetingId, { status: 'minutes' });

    expect(await finishRecording(meetingId)).toBe('saved');

    expect((await getMeeting(meetingId))?.status).toBe('minutes');
    expect(await getAudio(meetingId)).not.toBeNull();
  });



  // Regression: two settles at once, and updateMeeting's read-then-write put the
  // status back, so the second reported a finished recording as silent.
  it.each([0, 1, 2, 3])(
    'settles once when a second settle starts %i IndexedDB steps after the first',
    async (steps) => {
      await putBatch(batch(0), wav());
      await completeBatch(batch(0), [seg('Hej.', 0)]);

      const first = finishRecording(meetingId);
      for (let i = 0; i < steps; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(await Promise.all([first, finishRecording(meetingId)])).toEqual(['saved', 'saved']);

      expect((await getMeeting(meetingId))?.status).toBe('review');
      expect((await getTranscript(meetingId))?.segments.map((s) => s.text)).toEqual(['Hej.']);
    },
  );

  it('settles a waiting recording by itself once its last batch is transcribed', async () => {
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    await putBatch(batch(0), wav());

    expect(await finishRecording(meetingId)).toBe('waiting');
    answer(new Response(JSON.stringify({ text: 'Hej.' }), { status: 200 }));

    await vi.waitFor(async () => expect((await getMeeting(meetingId))?.status).toBe('review'));
    expect((await getTranscript(meetingId))?.segments.map((s) => s.text)).toEqual(['Hej.']);
  });

  it('does not wait for a batch whose audio is gone, and marks it in the transcript', async () => {
    await putBatch(batch(0));

    expect(await finishRecording(meetingId)).toBe('waiting');

    await vi.waitFor(async () => expect((await getMeeting(meetingId))?.status).toBe('review'));
    expect((await getTranscript(meetingId))?.segments[0].text).toMatch(/kunne ikke transskriberes/);
  });

  // Regression: a silent re-recording reported the old transcript as its own.
  it('keeps the transcript a re-recorded meeting had when the new take has no speech', async () => {
    await putBatch(batch(0), wav());
    await completeBatch(batch(0), [seg('Gammel.', 0)]);
    await finishRecording(meetingId);
    await updateMeeting(meetingId, { status: 'recording' });
    await saveAudio(meetingId, new Blob(['stille']), 'audio/webm');
    await putBatch(batch(1), wav());
    await completeBatch(batch(1), []);

    // The screen and the drain watcher both settle it; both must hear there was no speech.
    expect(await Promise.all([finishRecording(meetingId), finishRecording(meetingId)])).toEqual(['empty', 'empty']);

    expect((await getTranscript(meetingId))?.segments.map((s) => s.text)).toEqual(['Gammel.']);
    // Back where it was before the take, without the silent take's audio.
    expect(await getMeeting(meetingId)).toMatchObject({ status: 'review', audioDeleted: true });
    expect(await getAudio(meetingId)).toBeNull();
  });

  it('waits, and marks the meeting processing, while a batch is still untranscribed', async () => {
    await putBatch(batch(0), wav());
    await completeBatch(batch(0), [seg('Hej.', 0)]);
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
    await completeBatch(batch(0), [seg('Hej.', 0)]);
    await finalizeRecordingToTranscript(meetingId, { diarizationStatus: 'done' });

    expect(await finishRecording(meetingId)).toBe('saved');

    expect(await getMeeting(meetingId)).not.toBeNull();
    expect((await getTranscript(meetingId))?.segments.map((s) => s.text)).toEqual(['Hej.']);
  });

  it.each([
    ['no batch at all', async () => {}],
    ['only batches without speech', async () => {
      await putBatch(batch(0), wav());
      await completeBatch(batch(0), []);
    }],
  ])('reports empty and deletes the meeting when there is %s', async (_case, seed) => {
    await seed();

    expect(await finishRecording(meetingId)).toBe('empty');

    expect(await getMeeting(meetingId)).toBeNull();
    expect(await getTranscript(meetingId)).toBeNull();
    expect(await listBatches(meetingId)).toEqual([]);
  });
});

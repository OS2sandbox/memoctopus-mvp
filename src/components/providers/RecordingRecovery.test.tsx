// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { setStorageUserId } from '@/lib/storage/scope';
import { createMeeting, getMeeting, updateMeeting } from '@/lib/storage/meetings';
import { saveAudio } from '@/lib/storage/audio';
import { getTranscript } from '@/lib/storage/transcripts';
import {
  putBatch,
  listBatches,
  getPendingAudio,
  PENDING_AUDIO_TTL_MS,
} from '@/lib/storage/recording';
import { RecordingRecovery } from './RecordingRecovery';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  setStorageUserId(crypto.randomUUID());
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const T0 = Date.parse('2026-01-01T10:00:00.000Z');
const ok = (text: string) => new Response(JSON.stringify({ text }), { status: 200 });
const wav = () => new Uint8Array(16).fill(1).buffer;

function batch(meetingId: string, seq: number) {
  return {
    meetingId,
    seq,
    session: 0,
    status: 'pending' as const,
    intervals: [{ originalStart: seq * 27, originalEnd: seq * 27 + 27, wavOffset: 0, wavDuration: 27 }],
    totalWavDuration: 27,
  };
}

// A recording stopped with seq 0 left for longer than the audio is kept and seq 1
// still waiting: the state a closed tab leaves behind.
async function stoppedRecording(status: 'processing' | 'recording') {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const meeting = await createMeeting({ title: 'Møde', status });
  await putBatch(batch(meeting.id, 0), wav());
  vi.setSystemTime(T0 + PENDING_AUDIO_TTL_MS);
  await putBatch(batch(meeting.id, 1), wav());
  vi.setSystemTime(T0 + PENDING_AUDIO_TTL_MS + 1);
  return meeting.id;
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await act(() => new Promise((resolve) => setImmediate(resolve)));
  }
  throw new Error('condition never held');
}

describe('RecordingRecovery', () => {
  it('on mount sweeps expired audio, sends what waits and turns the ledger into the transcript', async () => {
    fetchMock.mockResolvedValue(ok('Hej.'));
    const meetingId = await stoppedRecording('processing');

    render(<RecordingRecovery />);
    await until(async () => (await getMeeting(meetingId))?.status === 'review');

    expect(await getMeeting(meetingId)).toMatchObject({ status: 'review', audioDeleted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getTranscript(meetingId))?.segments).toEqual([
      { speaker: 'Taler 1', start: 0, end: 27, text: '[Lyden fra 00:00 til 00:27 kunne ikke transskriberes]' },
      { speaker: 'Taler 1', start: 27, end: 54, text: 'Hej.' },
    ]);
    expect((await getTranscript(meetingId))?.diarizationStatus).toBe('done');
    expect(await listBatches(meetingId)).toEqual([]);
    expect(await getPendingAudio(meetingId, 1)).toBeNull();
  });

  it('keeps the stored recording of a meeting that has one and leaves diarization to the review', async () => {
    fetchMock.mockResolvedValue(ok('Hej.'));
    const meetingId = await stoppedRecording('processing');
    await saveAudio(meetingId, new Blob(['lyd']), 'audio/webm');

    render(<RecordingRecovery />);
    await until(async () => (await getMeeting(meetingId))?.status === 'review');

    expect((await getMeeting(meetingId))?.audioDeleted).toBe(false);
    expect((await getTranscript(meetingId))?.diarizationStatus).toBe('pending');
  });

  it('leaves an interrupted recording for the user to resume', async () => {
    fetchMock.mockResolvedValue(ok('Hej.'));
    const meetingId = await stoppedRecording('recording');

    render(<RecordingRecovery />);
    // The sweep is the first step of a run; once it has marked seq 0 the run has
    // looked at every meeting.
    await until(async () => (await listBatches(meetingId))[0]?.status === 'lost');
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect((await getMeeting(meetingId))?.status).toBe('recording');
    expect((await listBatches(meetingId)).map((b) => b.status)).toEqual(['lost', 'pending']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs again when the connection comes back', async () => {
    fetchMock.mockResolvedValue(ok('Hej.'));
    const meetingId = await stoppedRecording('recording');
    render(<RecordingRecovery />);
    await until(async () => (await listBatches(meetingId))[0]?.status === 'lost');

    // Stopped after the first run had passed it by.
    await updateMeeting(meetingId, { status: 'processing' });
    window.dispatchEvent(new Event('online'));
    await until(async () => (await getMeeting(meetingId))?.status === 'review');

    expect((await getTranscript(meetingId))?.segments.at(-1)?.text).toBe('Hej.');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTranscribe = vi.hoisted(() => vi.fn());
const mockDiarize = vi.hoisted(() => vi.fn());
const mockStoreTranscript = vi.hoisted(() => vi.fn());
const mockEnsemble = vi.hoisted(() => vi.fn());
const mockIsEnsemble = vi.hoisted(() => vi.fn(() => false));

vi.mock('@/lib/audio/vad-batch-server', () => ({
  transcribeWithVadBatches: mockTranscribe,
  transcribeEnsemble: mockEnsemble,
  isEnsembleDiarization: mockIsEnsemble,
}));

vi.mock('@/lib/ai/diarization', () => ({
  getDiarizationProvider: () => ({ diarize: mockDiarize }),
}));

vi.mock('@/lib/bot-pending-audio', () => ({
  storePendingTranscript: mockStoreTranscript,
}));

import { processBotRecording } from './bot-transcribe';

const SEGMENTS = [
  { speaker: 'Taler 1', start: 0, end: 3, text: 'hej' },
  { speaker: 'Taler 1', start: 4, end: 8, text: 'med dig' },
];
const TURNS = [
  { speaker: 'SPEAKER_00', start: 0, end: 3.5 },
  { speaker: 'SPEAKER_01', start: 3.5, end: 9 },
];

beforeEach(() => {
  mockTranscribe.mockReset();
  mockDiarize.mockReset();
  mockStoreTranscript.mockReset().mockResolvedValue(undefined);
  mockEnsemble.mockReset();
  mockIsEnsemble.mockReset().mockReturnValue(false);
});

describe('processBotRecording', () => {
  it('ensemble mode: stashes diarized segments from one call, skipping the diarization pass', async () => {
    mockIsEnsemble.mockReturnValue(true);
    const ENSEMBLE_SEGMENTS = [
      { speaker: 'Taler 1', start: 0, end: 3, text: 'hej' },
      { speaker: 'Taler 2', start: 3, end: 6, text: 'dav' },
    ];
    mockEnsemble.mockResolvedValueOnce(ENSEMBLE_SEGMENTS);

    await processBotRecording('m1', Buffer.from('audio'), 'audio/webm');

    expect(mockEnsemble).toHaveBeenCalledOnce();
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(mockDiarize).not.toHaveBeenCalled();
    const [meetingId, transcript] = mockStoreTranscript.mock.calls[0];
    expect(meetingId).toBe('m1');
    expect(transcript).toMatchObject({ status: 'ready', diarized: true });
    expect(transcript.segments).toEqual(ENSEMBLE_SEGMENTS);
  });

  it('stashes a ready transcript with diarized speaker labels', async () => {
    mockTranscribe.mockResolvedValueOnce(SEGMENTS);
    mockDiarize.mockResolvedValueOnce(TURNS);

    await processBotRecording('m1', Buffer.from('audio'), 'audio/webm');

    expect(mockStoreTranscript).toHaveBeenCalledTimes(1);
    const [meetingId, transcript] = mockStoreTranscript.mock.calls[0];
    expect(meetingId).toBe('m1');
    expect(transcript.status).toBe('ready');
    expect(transcript.diarized).toBe(true);
    // Speaker turns merged in: the two segments overlap different turns.
    expect(transcript.segments).toHaveLength(2);
    expect(transcript.segments[0].speaker).not.toBe(transcript.segments[1].speaker);
  });

  it('runs transcription and diarization in parallel on the same buffer', async () => {
    let diarizeStarted = false;
    mockDiarize.mockImplementationOnce(async () => { diarizeStarted = true; return []; });
    mockTranscribe.mockImplementationOnce(async () => {
      // Diarization must have been dispatched before transcription resolves.
      await Promise.resolve();
      expect(diarizeStarted).toBe(true);
      return SEGMENTS;
    });

    await processBotRecording('m1', Buffer.from('audio'), 'audio/webm');
    expect(mockDiarize).toHaveBeenCalledOnce();
    expect(mockDiarize.mock.calls[0][1]).toBe('audio/webm');
  });

  it('ships the transcript with default labels when diarization fails', async () => {
    mockTranscribe.mockResolvedValueOnce(SEGMENTS);
    mockDiarize.mockRejectedValueOnce(new Error('tunnel down'));

    await processBotRecording('m1', Buffer.from('audio'), 'audio/webm');

    const [, transcript] = mockStoreTranscript.mock.calls[0];
    expect(transcript.status).toBe('ready');
    expect(transcript.diarized).toBe(false);
    expect(transcript.segments).toEqual(SEGMENTS);
  });

  it('marks the stash failed when transcription fails', async () => {
    mockTranscribe.mockRejectedValueOnce(new Error('ffmpeg missing'));
    mockDiarize.mockResolvedValueOnce(TURNS);

    await processBotRecording('m1', Buffer.from('audio'), 'audio/webm');

    expect(mockStoreTranscript).toHaveBeenCalledWith('m1', { status: 'failed' });
  });

  it('logs only the error class when STT or diarization fail, never the message or body', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockTranscribe.mockRejectedValueOnce(Object.assign(new Error('body: Budget 2024 hemmeligt'), { status: 502 }));
    mockDiarize.mockRejectedValueOnce(new Error('body: Anna Hansen sagde noget'));
    await processBotRecording('m1', Buffer.from('audio'), 'audio/webm');

    mockTranscribe.mockResolvedValueOnce(SEGMENTS);
    mockDiarize.mockRejectedValueOnce(new Error('body: Anna Hansen sagde noget'));
    await processBotRecording('m1', Buffer.from('audio'), 'audio/webm');

    mockIsEnsemble.mockReturnValue(true);
    mockEnsemble.mockRejectedValueOnce(new Error('body: Budget 2024 hemmeligt'));
    await processBotRecording('m1', Buffer.from('audio'), 'audio/webm');

    expect(spy).toHaveBeenCalledTimes(3);
    for (const call of spy.mock.calls) expect(call).toHaveLength(1);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toMatch(/Budget|Anna|hemmeligt/);
    expect(logged).toContain('status=502');
    spy.mockRestore();
  });

  it('never throws — failures degrade to the client fallback', async () => {
    mockTranscribe.mockRejectedValueOnce(new Error('boom'));
    mockDiarize.mockRejectedValueOnce(new Error('boom'));
    mockStoreTranscript.mockRejectedValue(new Error('disk full'));

    await expect(processBotRecording('m1', Buffer.from('audio'), 'audio/webm')).resolves.toBeUndefined();
  });
});

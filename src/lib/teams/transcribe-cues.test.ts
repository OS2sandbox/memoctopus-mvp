import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDecode = vi.hoisted(() => vi.fn());
const mockTranscribeRaw = vi.hoisted(() => vi.fn());

vi.mock('@/lib/audio/decode-server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audio/decode-server')>(
    '@/lib/audio/decode-server',
  );
  return { decodeToMono16k: mockDecode, encodeMono16kWav: actual.encodeMono16kWav };
});

vi.mock('@/lib/ai/transcription', () => ({
  HviskeProvider: class {
    transcribeRaw = mockTranscribeRaw;
  },
}));

import { transcribeAlongCues, setCueTranscriptionProvider } from './transcribe-cues';
import { parseVtt } from './vtt';

const SAMPLE_RATE = 16_000;

/** 60 s of silence — the content does not matter, only how it is sliced. */
const AUDIO = new Float32Array(60 * SAMPLE_RATE);

const VTT = [
  'WEBVTT',
  '',
  '00:00:05.000 --> 00:00:08.000',
  '<v Mette Hansen>Velkommen til mødet.</v>',
  '',
  '00:00:08.500 --> 00:00:12.000',
  '<v Jens Poulsen>Tak, lad os komme i gang.</v>',
  '',
  '00:00:40.000 --> 00:00:44.000',
  '<v Mette Hansen>Så tager vi punkt to.</v>',
  '',
].join('\n');

const CUES = parseVtt(VTT);

beforeEach(() => {
  setCueTranscriptionProvider(null);
  mockDecode.mockReset().mockResolvedValue(AUDIO);
  mockTranscribeRaw.mockReset().mockResolvedValue({ text: 'Goddag alle sammen.', latencyMs: 5 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('transcribeAlongCues', () => {
  it('sends one request per cue slice, not one per cue', async () => {
    const result = await transcribeAlongCues(Buffer.from('mp4'), CUES);

    // Cues 1 and 2 are a breath apart and share a slice; cue 3 is half a minute later.
    expect(result.batches).toBe(2);
    expect(mockTranscribeRaw).toHaveBeenCalledTimes(2);
  });

  it('gives each segment the display name of the cue it falls in', async () => {
    mockTranscribeRaw.mockResolvedValue({ text: 'Velkommen. Tak skal du have for det.', latencyMs: 5 });

    const { segments } = await transcribeAlongCues(Buffer.from('mp4'), CUES);

    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(['Mette Hansen', 'Jens Poulsen']).toContain(segment.speaker);
    }
  });

  it('places segments on the recording timeline, not the slice timeline', async () => {
    const { segments } = await transcribeAlongCues(Buffer.from('mp4'), CUES);
    // Nothing was said before the first cue at 5 s.
    expect(Math.min(...segments.map((s) => s.start))).toBeGreaterThanOrEqual(4);
    expect(Math.max(...segments.map((s) => s.end))).toBeLessThanOrEqual(45);
  });

  it('drops a slice whose transcription degenerated', async () => {
    mockTranscribeRaw.mockResolvedValue({ text: 'Det. '.repeat(30), latencyMs: 5 });
    const { segments, emptyBatches } = await transcribeAlongCues(Buffer.from('mp4'), CUES);
    expect(segments).toEqual([]);
    expect(emptyBatches).toBe(2);
  });

  it('retries a failed slice once and gives up on it alone', async () => {
    mockTranscribeRaw
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue({ text: 'Goddag alle sammen.', latencyMs: 5 });

    const { segments } = await transcribeAlongCues(Buffer.from('mp4'), CUES);
    expect(segments.length).toBeGreaterThan(0);
    expect(mockTranscribeRaw).toHaveBeenCalledTimes(3);
  });

  it('survives a slice that fails both times', async () => {
    mockTranscribeRaw.mockRejectedValue(new Error('503'));
    const { segments } = await transcribeAlongCues(Buffer.from('mp4'), CUES);
    expect(segments).toEqual([]);
  });

  it('does nothing when the transcript holds no usable cues', async () => {
    const result = await transcribeAlongCues(Buffer.from('mp4'), parseVtt('WEBVTT\n\n'));
    expect(result).toEqual({ segments: [], batches: 0, emptyBatches: 0 });
    expect(mockTranscribeRaw).not.toHaveBeenCalled();
  });

  it('hands hviske a wav, never the mp4 it was given', async () => {
    await transcribeAlongCues(Buffer.from('mp4'), CUES);
    const [buffer, mime] = mockTranscribeRaw.mock.calls[0];
    expect(mime).toBe('audio/wav');
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTranscriptionsCreate = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class OpenAI {
    audio = { transcriptions: { create: mockTranscriptionsCreate } };
  },
}));

import { HviskeProvider, ElevenLabsProvider, getTranscriptionProvider, setTranscriptionProvider } from './transcription';

// ─── HviskeProvider ───────────────────────────────────────────────────────────
// Exercises the shared OpenAI-compatible transcription path + heuristic diarization.

describe('HviskeProvider.transcribe', () => {
  let provider: HviskeProvider;

  beforeEach(() => {
    provider = new HviskeProvider();
    mockTranscriptionsCreate.mockReset();
  });

  it('returns a single fallback segment when API returns no segments', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'Hello world', segments: [] });

    const result = await provider.transcribe(Buffer.from('audio'), 'audio/webm');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      speaker: 'Taler 1',
      start: 0,
      end: 0,
      text: 'Hello world',
    });
  });

  it('returns a fallback segment when segments is undefined', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'Fallback' });

    const result = await provider.transcribe(Buffer.from('audio'), 'audio/webm');

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Fallback');
  });

  it('maps segments keeping speaker 1 when gaps are ≤ 2s', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({
      text: 'full',
      segments: [
        { start: 0, end: 2, text: ' First ' },
        { start: 3, end: 5, text: ' Second ' }, // 1s gap — no switch
      ],
    });

    const result = await provider.transcribe(Buffer.from('a'), 'audio/webm');

    expect(result[0].speaker).toBe('Taler 1');
    expect(result[1].speaker).toBe('Taler 1');
  });

  it('switches to Taler 2 when gap exceeds 2 seconds', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({
      text: 'full',
      segments: [
        { start: 0, end: 2, text: 'A' },
        { start: 5, end: 7, text: 'B' }, // 3s gap
      ],
    });

    const result = await provider.transcribe(Buffer.from('a'), 'audio/webm');

    expect(result[0].speaker).toBe('Taler 1');
    expect(result[1].speaker).toBe('Taler 2');
  });

  it('switches back to Taler 1 on a second gap > 2s', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({
      text: 'full',
      segments: [
        { start: 0, end: 2, text: 'A' },
        { start: 5, end: 7, text: 'B' }, // → Taler 2
        { start: 10, end: 12, text: 'C' }, // → Taler 1
      ],
    });

    const result = await provider.transcribe(Buffer.from('a'), 'audio/webm');

    expect(result[0].speaker).toBe('Taler 1');
    expect(result[1].speaker).toBe('Taler 2');
    expect(result[2].speaker).toBe('Taler 1');
  });

  it('does not switch speaker at exactly 2s gap (boundary is > 2)', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({
      text: 'full',
      segments: [
        { start: 0, end: 2, text: 'A' },
        { start: 4, end: 6, text: 'B' }, // exactly 2s gap — no switch
      ],
    });

    const result = await provider.transcribe(Buffer.from('a'), 'audio/webm');

    expect(result[0].speaker).toBe('Taler 1');
    expect(result[1].speaker).toBe('Taler 1');
  });

  it('trims whitespace from segment text', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({
      text: 'x',
      segments: [{ start: 0, end: 1, text: '  padded text  ' }],
    });

    const result = await provider.transcribe(Buffer.from('a'), 'audio/webm');

    expect(result[0].text).toBe('padded text');
  });

  it('preserves start/end timestamps from transcription segments', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({
      text: 'x',
      segments: [{ start: 3.5, end: 7.2, text: 'Text' }],
    });

    const result = await provider.transcribe(Buffer.from('a'), 'audio/webm');

    expect(result[0].start).toBe(3.5);
    expect(result[0].end).toBe(7.2);
  });

  it.each([
    ['audio/webm', 'webm'],
    ['audio/mp4', 'mp4'],
    ['audio/mpeg', 'mp3'],
    ['audio/mp3', 'mp3'],
    ['audio/wav', 'wav'],
    ['audio/ogg', 'ogg'],
    ['audio/flac', 'flac'],
    ['audio/x-m4a', 'm4a'],
    ['audio/unknown', 'webm'],
  ])('maps mime type %s to file extension .%s', async (mime, ext) => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: '', segments: [] });

    await provider.transcribe(Buffer.from('a'), mime);

    const call = mockTranscriptionsCreate.mock.calls[0][0];
    expect(call.file.name).toMatch(new RegExp(`\\.${ext}$`));
  });

  it('sends language=da to the transcription API', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: '', segments: [] });

    await provider.transcribe(Buffer.from('a'), 'audio/webm');

    const call = mockTranscriptionsCreate.mock.calls[0][0];
    expect(call.language).toBe('da');
  });

  it('requests verbose_json response format', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: '', segments: [] });

    await provider.transcribe(Buffer.from('a'), 'audio/webm');

    const call = mockTranscriptionsCreate.mock.calls[0][0];
    expect(call.response_format).toBe('verbose_json');
  });
});

// ─── Provider singleton ───────────────────────────────────────────────────────

describe('getTranscriptionProvider / setTranscriptionProvider', () => {
  it('returns an ElevenLabsProvider by default', () => {
    setTranscriptionProvider(null as never);
    const p = getTranscriptionProvider();
    expect(p).toBeInstanceOf(ElevenLabsProvider);
  });

  it('returns the same instance on repeated calls', () => {
    setTranscriptionProvider(null as never);
    expect(getTranscriptionProvider()).toBe(getTranscriptionProvider());
  });

  it('returns the injected provider after setTranscriptionProvider', () => {
    const stub = { transcribe: vi.fn() };
    setTranscriptionProvider(stub);
    expect(getTranscriptionProvider()).toBe(stub);
    setTranscriptionProvider(null as never); // reset
  });
});

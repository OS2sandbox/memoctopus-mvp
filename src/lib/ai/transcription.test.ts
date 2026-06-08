import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTranscriptionsCreate = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class OpenAI {
    audio = { transcriptions: { create: mockTranscriptionsCreate } };
  },
}));

import { HviskeProvider, getTranscriptionProvider, setTranscriptionProvider } from './transcription';

// ─── HviskeProvider.transcribe ────────────────────────────────────────────────

describe('HviskeProvider.transcribe', () => {
  let provider: HviskeProvider;

  beforeEach(() => {
    provider = new HviskeProvider();
    mockTranscriptionsCreate.mockReset();
  });

  it('sends response_format json to the API', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'Hej.' });

    await provider.transcribe(Buffer.from('a'), 'audio/webm');

    const call = mockTranscriptionsCreate.mock.calls[0][0];
    expect(call.response_format).toBe('json');
  });

  it('sends language=da to the API', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'Hej.' });

    await provider.transcribe(Buffer.from('a'), 'audio/webm');

    const call = mockTranscriptionsCreate.mock.calls[0][0];
    expect(call.language).toBe('da');
  });

  it('returns an empty array when the API returns empty text', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: '' });

    const result = await provider.transcribe(Buffer.from('a'), 'audio/webm');

    expect(result).toHaveLength(0);
  });

  it('returns a single segment when text has no sentence boundaries', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'Ingen punktum her' });

    const result = await provider.transcribe(Buffer.from('a'), 'audio/webm');

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Ingen punktum her');
    expect(result[0].speaker).toBe('Taler 1');
  });

  it('splits text into multiple segments on sentence boundaries', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'Første sætning. Anden sætning. Tredje sætning.' });

    const result = await provider.transcribe(Buffer.alloc(8000), 'audio/webm');

    expect(result).toHaveLength(3);
    expect(result[0].text).toBe('Første sætning.');
    expect(result[1].text).toBe('Anden sætning.');
    expect(result[2].text).toBe('Tredje sætning.');
  });

  it('labels all segments as Taler 1', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'A. B. C.' });

    const result = await provider.transcribe(Buffer.alloc(8000), 'audio/webm');

    expect(result.every(s => s.speaker === 'Taler 1')).toBe(true);
  });

  it('timestamps are monotonically increasing across segments', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'Første. Anden. Tredje.' });

    const result = await provider.transcribe(Buffer.alloc(16_000), 'audio/webm');

    for (let i = 1; i < result.length; i++) {
      expect(result[i].start).toBeGreaterThanOrEqual(result[i - 1].end);
    }
  });

  it('total duration spans the estimated audio length', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'Hej. Verden.' });

    // 8000 bytes → ~1 second estimated (8000 / 8000)
    const result = await provider.transcribe(Buffer.alloc(8_000), 'audio/webm');

    const lastEnd = result[result.length - 1].end;
    expect(lastEnd).toBeCloseTo(1.0, 1);
  });

  it('distributes duration proportionally by word count', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'Et ord. Tre separate ord her.' });

    // 8000 bytes → 1 s total
    const result = await provider.transcribe(Buffer.alloc(8_000), 'audio/webm');

    // Sentence 1: 2 words; sentence 2: 4 words → total 6
    // Sentence 1 end ≈ 2/6 = 0.333 s
    expect(result[0].end).toBeCloseTo(2 / 6, 2);
    expect(result[1].start).toBeCloseTo(2 / 6, 2);
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
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'x.' });

    await provider.transcribe(Buffer.from('a'), mime);

    const call = mockTranscriptionsCreate.mock.calls[0][0];
    expect(call.file.name).toMatch(new RegExp(`\\.${ext}$`));
  });

  it('trims whitespace from the full text before splitting', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: '  Hej verden.  ' });

    const result = await provider.transcribe(Buffer.alloc(8_000), 'audio/webm');

    expect(result[0].text).toBe('Hej verden.');
  });
});

// ─── HviskeProvider.transcribeRaw ─────────────────────────────────────────────

describe('HviskeProvider.transcribeRaw', () => {
  let provider: HviskeProvider;

  beforeEach(() => {
    provider = new HviskeProvider();
    mockTranscriptionsCreate.mockReset();
  });

  it('returns the text string from the API response', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'Hej verden' });

    const result = await provider.transcribeRaw(Buffer.from('audio'), 'audio/wav');

    expect(result).toBe('Hej verden');
  });

  it('returns empty string when API returns no text', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: '' });

    const result = await provider.transcribeRaw(Buffer.from('audio'), 'audio/wav');

    expect(result).toBe('');
  });

  it('uses response_format json (not verbose_json)', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'x' });

    await provider.transcribeRaw(Buffer.from('a'), 'audio/wav');

    const call = mockTranscriptionsCreate.mock.calls[0][0];
    expect(call.response_format).toBe('json');
  });

  it('does not request timestamp_granularities', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'x' });

    await provider.transcribeRaw(Buffer.from('a'), 'audio/wav');

    const call = mockTranscriptionsCreate.mock.calls[0][0];
    expect(call.timestamp_granularities).toBeUndefined();
  });

  it('sends the correct file extension for audio/wav', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'x' });

    await provider.transcribeRaw(Buffer.from('a'), 'audio/wav');

    const call = mockTranscriptionsCreate.mock.calls[0][0];
    expect(call.file.name).toMatch(/\.wav$/);
  });
});

// ─── Provider singleton ───────────────────────────────────────────────────────

describe('getTranscriptionProvider / setTranscriptionProvider', () => {
  it('returns a HviskeProvider by default', () => {
    setTranscriptionProvider(null as never);
    const p = getTranscriptionProvider();
    expect(p).toBeInstanceOf(HviskeProvider);
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

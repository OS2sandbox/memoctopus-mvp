// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { transcribeBatch } from './transcribe-batch';

const batch = {
  wav: new Uint8Array(8).buffer,
  intervals: [{ originalStart: 10, originalEnd: 20, wavOffset: 0, wavDuration: 10 }],
  totalWavDuration: 10,
};

function respond(status: number, body: unknown = {}) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('transcribeBatch', () => {
  it('posts the WAV to the utterance route and places the text on the meeting timeline', async () => {
    respond(200, { text: 'Godmorgen alle sammen.' });

    const result = await transcribeBatch('m1', batch);

    expect(result).toEqual({
      kind: 'text',
      segments: [{ speaker: 'Taler 1', start: 10, end: 20, text: 'Godmorgen alle sammen.' }],
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/meetings/m1/utterance');
    expect((init?.body as FormData).get('audio')).toBeInstanceOf(Blob);
  });

  it('treats an empty text as silence, not as a failure', async () => {
    respond(200, { text: '' });
    expect(await transcribeBatch('m1', batch)).toEqual({ kind: 'text', segments: [] });
  });

  it.each([
    ['401', () => respond(401, { error: 'Unauthorized' }), 'auth'],
    ['502', () => respond(502, { error: 'Transcription failed' }), 'retry'],
    ['a body without text', () => respond(200, { error: 'odd' }), 'retry'],
    ['a network error', () => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))), 'retry'],
  ])('maps %s to %s', async (_name, arrange, kind) => {
    arrange();
    expect((await transcribeBatch('m1', batch)).kind).toBe(kind);
  });
});

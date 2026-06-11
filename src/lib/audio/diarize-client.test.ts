import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchDiarizationTurns } from './diarize-client';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => vi.unstubAllGlobals());

const wav = new Blob([new Uint8Array(3000)], { type: 'audio/wav' });

describe('fetchDiarizationTurns', () => {
  it('POSTs the WAV to the diarize route and returns the turns', async () => {
    const turns = [{ speaker: 'SPEAKER_00', start: 0, end: 2 }];
    mockFetch.mockResolvedValueOnce(jsonResponse({ turns }));

    const result = await fetchDiarizationTurns('meet-1', wav);

    expect(result).toEqual(turns);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/meetings/meet-1/diarize');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('fails soft to [] when the response is not ok', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false));
    expect(await fetchDiarizationTurns('m', wav)).toEqual([]);
  });

  it('fails soft to [] when turns is missing or not an array', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ turns: null }));
    expect(await fetchDiarizationTurns('m', wav)).toEqual([]);
  });

  it('fails soft to [] when the request throws (service/tunnel down)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await fetchDiarizationTurns('m', wav)).toEqual([]);
  });
});

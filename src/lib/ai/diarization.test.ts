import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PyannoteProvider,
  getDiarizationProvider,
  setDiarizationProvider,
  type DiarizationProvider,
  type SpeakerTurn,
} from './diarization';

const ENV = process.env;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env = { ...ENV };
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  process.env = ENV;
  vi.unstubAllGlobals();
  setDiarizationProvider(null as never); // reset the singleton between tests
});

describe('PyannoteProvider.diarize', () => {
  const buf = Buffer.alloc(5_000, 1);

  it('POSTs to <DIARIZATION_URL>/diarize and returns parsed turns', async () => {
    process.env.DIARIZATION_URL = 'http://diar:5000';
    const turns: SpeakerTurn[] = [
      { speaker: 'SPEAKER_00', start: 0, end: 2 },
      { speaker: 'SPEAKER_01', start: 2, end: 4 },
    ];
    mockFetch.mockResolvedValueOnce(jsonResponse({ turns }));

    const result = await new PyannoteProvider().diarize(buf, 'audio/wav');

    expect(result).toEqual(turns);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://diar:5000/diarize');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('strips a trailing slash from DIARIZATION_URL', async () => {
    process.env.DIARIZATION_URL = 'http://diar:5000/';
    mockFetch.mockResolvedValueOnce(jsonResponse({ turns: [] }));
    await new PyannoteProvider().diarize(buf, 'audio/wav');
    expect(mockFetch.mock.calls[0][0]).toBe('http://diar:5000/diarize');
  });

  it('sends a bearer Authorization header when DIARIZATION_API_KEY is set', async () => {
    process.env.DIARIZATION_API_KEY = 'secret';
    mockFetch.mockResolvedValueOnce(jsonResponse({ turns: [] }));
    await new PyannoteProvider().diarize(buf, 'audio/wav');
    expect(mockFetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer secret' });
  });

  it('omits the Authorization header when DIARIZATION_API_KEY is unset', async () => {
    delete process.env.DIARIZATION_API_KEY;
    mockFetch.mockResolvedValueOnce(jsonResponse({ turns: [] }));
    await new PyannoteProvider().diarize(buf, 'audio/wav');
    expect(mockFetch.mock.calls[0][1].headers).toBeUndefined();
  });

  it('returns [] when the response body has no turns array', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    expect(await new PyannoteProvider().diarize(buf, 'audio/wav')).toEqual([]);
  });

  it('returns [] when turns is not an array', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ turns: null }));
    expect(await new PyannoteProvider().diarize(buf, 'audio/wav')).toEqual([]);
  });

  it('throws when the service responds non-ok (so the route can fail-soft)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 502));
    await expect(new PyannoteProvider().diarize(buf, 'audio/wav')).rejects.toThrow('502');
  });
});

describe('getDiarizationProvider / setDiarizationProvider', () => {
  it('returns a PyannoteProvider by default', () => {
    setDiarizationProvider(null as never);
    expect(getDiarizationProvider()).toBeInstanceOf(PyannoteProvider);
  });

  it('returns the injected provider after setDiarizationProvider', () => {
    const stub: DiarizationProvider = { diarize: vi.fn(async () => []) };
    setDiarizationProvider(stub);
    expect(getDiarizationProvider()).toBe(stub);
  });

  it('memoises the provider instance across calls', () => {
    setDiarizationProvider(null as never);
    expect(getDiarizationProvider()).toBe(getDiarizationProvider());
  });
});

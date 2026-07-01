import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockDecode = vi.hoisted(() => vi.fn());
const mockEncode = vi.hoisted(() => vi.fn());
const mockUndiciFetch = vi.hoisted(() => vi.fn());

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();

  return {
    ...actual,
    fetch: mockUndiciFetch,
  };
});

vi.mock('@/lib/audio/decode-server', () => ({
  decodeToMono16k: mockDecode,
  encodeMono16kWav: mockEncode,
}));

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
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

beforeEach(() => {
  process.env = { ...ENV };
  mockUndiciFetch.mockReset();
  mockDecode.mockReset();
  mockEncode.mockReset();
});

afterEach(() => {
  process.env = ENV;
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

    mockUndiciFetch.mockResolvedValueOnce(jsonResponse({ turns }));

    const result = await new PyannoteProvider().diarize(buf, 'audio/wav');

    expect(result).toEqual(turns);

    const [url, init] = mockUndiciFetch.mock.calls[0];
    expect(url).toBe('http://diar:5000/diarize');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.dispatcher).toBeDefined();
    expect(init.signal).toBeDefined();
  });

  it('strips a trailing slash from DIARIZATION_URL', async () => {
    process.env.DIARIZATION_URL = 'http://diar:5000/';

    mockUndiciFetch.mockResolvedValueOnce(jsonResponse({ turns: [] }));

    await new PyannoteProvider().diarize(buf, 'audio/wav');

    expect(mockUndiciFetch.mock.calls[0][0]).toBe('http://diar:5000/diarize');
  });

  it('sends a bearer Authorization header when DIARIZATION_API_KEY is set', async () => {
    process.env.DIARIZATION_API_KEY = 'secret';

    mockUndiciFetch.mockResolvedValueOnce(jsonResponse({ turns: [] }));

    await new PyannoteProvider().diarize(buf, 'audio/wav');

    expect(mockUndiciFetch.mock.calls[0][1].headers).toEqual({
      Authorization: 'Bearer secret',
    });
  });

  it('omits the Authorization header when DIARIZATION_API_KEY is unset', async () => {
    delete process.env.DIARIZATION_API_KEY;

    mockUndiciFetch.mockResolvedValueOnce(jsonResponse({ turns: [] }));

    await new PyannoteProvider().diarize(buf, 'audio/wav');

    expect(mockUndiciFetch.mock.calls[0][1].headers).toBeUndefined();
  });

  it('returns [] when the response body has no turns array', async () => {
    mockUndiciFetch.mockResolvedValueOnce(jsonResponse({}));

    expect(await new PyannoteProvider().diarize(buf, 'audio/wav')).toEqual([]);
  });

  it('returns [] when turns is not an array', async () => {
    mockUndiciFetch.mockResolvedValueOnce(jsonResponse({ turns: null }));

    expect(await new PyannoteProvider().diarize(buf, 'audio/wav')).toEqual([]);
  });

  it('throws when the service responds non-ok (so the route can fail-soft)', async () => {
    mockUndiciFetch.mockResolvedValueOnce(jsonResponse({}, false, 502));

    await expect(new PyannoteProvider().diarize(buf, 'audio/wav')).rejects.toThrow('502');
  });

  it('does NOT decode when the input is already WAV', async () => {
    mockUndiciFetch.mockResolvedValueOnce(jsonResponse({ turns: [] }));

    await new PyannoteProvider().diarize(buf, 'audio/wav');

    expect(mockDecode).not.toHaveBeenCalled();
  });

  it('decodes compressed audio to WAV before forwarding to the service', async () => {
    const decoded = new Float32Array([0, 0.5, -0.5]);
    const wav = Buffer.from('RIFFwav');

    mockDecode.mockResolvedValueOnce(decoded);
    mockEncode.mockReturnValueOnce(wav);
    mockUndiciFetch.mockResolvedValueOnce(jsonResponse({ turns: [] }));

    await new PyannoteProvider().diarize(buf, 'audio/webm');

    expect(mockDecode).toHaveBeenCalledOnce();
    expect(mockDecode.mock.calls[0][0]).toBe(buf);
    expect(mockEncode).toHaveBeenCalledWith(decoded);

    // The forwarded file is the WAV, named with a .wav extension.
    const form = mockUndiciFetch.mock.calls[0][1].body as FormData;
    const file = form.get('file') as File;

    expect(file.type).toBe('audio/wav');
    expect(file.name).toBe('audio.wav');
  });

  it('falls back to the original audio when server-side decode fails', async () => {
    mockDecode.mockRejectedValueOnce(new Error('ffmpeg missing'));
    mockUndiciFetch.mockResolvedValueOnce(jsonResponse({ turns: [] }));

    await new PyannoteProvider().diarize(buf, 'audio/webm');

    // Still POSTs; the service may be able to decode it itself. Does not throw.
    expect(mockUndiciFetch).toHaveBeenCalledOnce();

    const form = mockUndiciFetch.mock.calls[0][1].body as FormData;
    const file = form.get('file') as File;

    expect(file.type).toBe('audio/webm');
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

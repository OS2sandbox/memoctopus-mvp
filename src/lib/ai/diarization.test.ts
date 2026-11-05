import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockDecode = vi.hoisted(() => vi.fn());
const mockEncode = vi.hoisted(() => vi.fn());
const mockUndiciFetch = vi.hoisted(() => vi.fn());
const agentOptions = vi.hoisted(() => [] as unknown[]);

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();

  // The real Agent, recording what it was built with.
  class RecordingAgent extends actual.Agent {
    constructor(options: ConstructorParameters<typeof actual.Agent>[0]) {
      super(options);
      agentOptions.push(options);
    }
  }

  return {
    ...actual,
    Agent: RecordingAgent,
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

type FormLike = {
  get(name: string): unknown;
};

type UploadedFileLike = {
  type?: string;
  name?: string;
};

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
  agentOptions.length = 0;
  mockUndiciFetch.mockReset();
  mockDecode.mockReset();
  mockEncode.mockReset();
});

afterEach(() => {
  process.env = ENV;
  setDiarizationProvider(null as never); // reset the singleton between tests
  vi.restoreAllMocks();
});

describe('PyannoteProvider.diarize', () => {
  const buf = Buffer.alloc(5_000, 1);

  // The browser has no time limit of its own (it waits for this route), so this one
  // number is the whole budget for a diarization request: our abort signal, and undici's
  // own header/body timers, which would otherwise cut a long CPU job off first.
  describe('DIARIZATION_TIMEOUT_MS', () => {
    beforeEach(() => {
      delete process.env.HVISKE_DIARIZE;
      mockUndiciFetch.mockResolvedValue(jsonResponse({ turns: [] }));
    });

    it('sets the abort signal and both undici timers', async () => {
      process.env.DIARIZATION_TIMEOUT_MS = '3600000';
      const timeout = vi.spyOn(AbortSignal, 'timeout');

      await new PyannoteProvider().diarize(buf, 'audio/wav');

      expect(timeout).toHaveBeenCalledWith(3_600_000);
      expect(agentOptions.at(-1)).toMatchObject({ headersTimeout: 3_600_000, bodyTimeout: 3_600_000 });
      expect(mockUndiciFetch.mock.calls[0][1].signal).toBe(timeout.mock.results[0].value);
    });

    it.each([[undefined], [''], ['abc'], ['0'], ['-5']])('defaults to 5 minutes for %j', async (value) => {
      if (value === undefined) delete process.env.DIARIZATION_TIMEOUT_MS;
      else process.env.DIARIZATION_TIMEOUT_MS = value;
      const timeout = vi.spyOn(AbortSignal, 'timeout');

      await new PyannoteProvider().diarize(buf, 'audio/wav');

      expect(timeout).toHaveBeenCalledWith(300_000);
      expect(agentOptions.at(-1)).toMatchObject({ headersTimeout: 300_000, bodyTimeout: 300_000 });
    });
  });

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
    expect(init.body).toBeDefined();
    expect(typeof (init.body as FormLike).get).toBe('function');
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

  it('no-ops to [] without fetching when ensemble mode (HVISKE_DIARIZE=true) is on', async () => {
    process.env.HVISKE_DIARIZE = 'true';
    const result = await new PyannoteProvider().diarize(buf, 'audio/webm');
    expect(result).toEqual([]);
    expect(mockUndiciFetch).not.toHaveBeenCalled();
    expect(mockDecode).not.toHaveBeenCalled();
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

  it('includes the response body when the service responds non-ok', async () => {
    mockUndiciFetch.mockResolvedValueOnce(jsonResponse('missing file', false, 422));

    await expect(new PyannoteProvider().diarize(buf, 'audio/wav')).rejects.toThrow(
      'Diarization service returned 422: missing file',
    );
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
    const form = mockUndiciFetch.mock.calls[0][1].body as FormLike;
    const file = form.get('file') as UploadedFileLike;

    expect(file.type).toBe('audio/wav');
    expect(file.name).toBe('audio.wav');
  });

  it('falls back to the original audio when server-side decode fails', async () => {
    mockDecode.mockRejectedValueOnce(new Error('ffmpeg missing'));
    mockUndiciFetch.mockResolvedValueOnce(jsonResponse({ turns: [] }));

    await new PyannoteProvider().diarize(buf, 'audio/webm');

    // Still POSTs; the service may be able to decode it itself. Does not throw.
    expect(mockUndiciFetch).toHaveBeenCalledOnce();

    const form = mockUndiciFetch.mock.calls[0][1].body as FormLike;
    const file = form.get('file') as UploadedFileLike;

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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture the options each `new OpenAI(...)` is constructed with.
const ctorArgs = vi.hoisted(() => [] as Array<{ apiKey: string; baseURL: string }>);

vi.mock('openai', () => ({
  default: class {
    constructor(opts: { apiKey: string; baseURL: string }) {
      ctorArgs.push(opts);
    }
  },
}));

import {
  countTokensExact,
  getLlmClient,
  llmModel,
  resetLlmClient,
  usingHostedOpenAI,
} from './llm-client';

const ENV = process.env;

beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  ctorArgs.length = 0;
  resetLlmClient();
});

afterEach(() => {
  process.env = ENV;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('llmModel (backend selection)', () => {
  it('defaults to the self-hosted vLLM model when no key/base is configured', () => {
    expect(llmModel('gpt-4o')).toBe('Qwen/Qwen3.6-27B');
  });

  it('uses the caller hosted model when an API key is set', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    expect(llmModel('gpt-4o')).toBe('gpt-4o');
  });

  it('uses the caller hosted model when LLM_BASE_URL is set (even without a key)', () => {
    process.env.LLM_BASE_URL = 'http://my-llm:8000/v1';
    expect(llmModel('gpt-4o-mini')).toBe('gpt-4o-mini');
  });

  it('LLM_MODEL overrides everything', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    process.env.LLM_MODEL = 'custom-model';
    expect(llmModel('gpt-4o')).toBe('custom-model');
  });

  it('treats a blank/whitespace key as no key (falls back to vLLM)', () => {
    process.env.OPENAI_API_KEY = '   ';
    expect(llmModel('gpt-4o')).toBe('Qwen/Qwen3.6-27B');
  });
});

describe('getLlmClient (base URL)', () => {
  it('points at the self-hosted vLLM by default', () => {
    getLlmClient();
    expect(ctorArgs.at(-1)?.baseURL).toBe('http://vllm-chat:8000/v1');
  });

  it('points at OpenAI when a key is set', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    getLlmClient();
    expect(ctorArgs.at(-1)?.baseURL).toBe('https://api.openai.com/v1');
  });

  it('honours an explicit LLM_BASE_URL (trailing slash trimmed)', () => {
    process.env.LLM_BASE_URL = 'http://my-llm:8000/v1/';
    getLlmClient();
    expect(ctorArgs.at(-1)?.baseURL).toBe('http://my-llm:8000/v1');
  });

  it('rebuilds the client when the backend changes', () => {
    getLlmClient(); // vLLM
    process.env.OPENAI_API_KEY = 'sk-x';
    getLlmClient(); // OpenAI
    expect(ctorArgs.map((a) => a.baseURL)).toEqual([
      'http://vllm-chat:8000/v1',
      'https://api.openai.com/v1',
    ]);
  });
});

describe('usingHostedOpenAI', () => {
  it('is false with no key and no base URL', () => {
    expect(usingHostedOpenAI()).toBe(false);
  });

  it('is true when only an API key is set', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    expect(usingHostedOpenAI()).toBe(true);
  });

  it('is false when LLM_BASE_URL points elsewhere, even with a key', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    process.env.LLM_BASE_URL = 'http://my-llm:8000/v1';
    expect(usingHostedOpenAI()).toBe(false);
  });

  it('treats a blank key as no key', () => {
    process.env.OPENAI_API_KEY = '   ';
    expect(usingHostedOpenAI()).toBe(false);
  });
});

describe('countTokensExact (vLLM /tokenize)', () => {
  function stubTokenize(respond: () => unknown) {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => respond(),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('posts { model, prompt } to /tokenize at the server root, not under /v1', async () => {
    process.env.LLM_BASE_URL = 'http://my-llm:8000/v1/';
    process.env.LLM_MODEL = 'my-model';
    const fetchMock = stubTokenize(() => ({ count: 42 }));

    expect(await countTokensExact('hej med dig')).toBe(42);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://my-llm:8000/tokenize');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'my-model', prompt: 'hej med dig' });
  });

  it('targets the bundled vLLM when nothing is configured', async () => {
    const fetchMock = stubTokenize(() => ({ count: 1 }));

    await countTokensExact('x');

    expect(fetchMock.mock.calls[0][0]).toBe('http://vllm-chat:8000/tokenize');
  });

  it.each([[{ count: '42' }], [{ tokens: [1, 2] }], [null]])(
    'returns null for a response without a numeric count: %j',
    async (body) => {
      stubTokenize(() => body);
      expect(await countTokensExact('x')).toBeNull();
    },
  );

  it('returns null without calling out on hosted OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    const fetchMock = stubTokenize(() => ({ count: 1 }));

    expect(await countTokensExact('x')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives up after 10 s and returns null, so a hung tokenizer cannot stall minutes', async () => {
    // Stand in for the 10 s timer with a signal that has already fired.
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort(new DOMException('timed out', 'TimeoutError')));
    // A tokenizer that never answers, except by honouring the abort signal.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init.signal;
            if (signal?.aborted) reject(signal.reason);
            signal?.addEventListener('abort', () => reject(signal.reason));
          }),
      ),
    );

    expect(await countTokensExact('x')).toBeNull();
    expect(timeout).toHaveBeenCalledWith(10_000);
  });
});

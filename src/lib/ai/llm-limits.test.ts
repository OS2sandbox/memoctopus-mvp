import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLlmLimits, transcriptBudgetChars } from './llm-limits';

const ENV = process.env;

beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_CONTEXT_TOKENS;
  delete process.env.LLM_MAX_OUTPUT_TOKENS;
  delete process.env.VLLM_CHAT_MAX_MODEL_LEN;
  vi.unstubAllGlobals();
});

afterEach(() => {
  process.env = ENV;
  vi.unstubAllGlobals();
});

describe('getLlmLimits defaults', () => {
  it('is conservative for self-hosted (no key, no base URL)', () => {
    expect(getLlmLimits()).toEqual({ contextTokens: 32_768, maxOutputTokens: 8_192 });
  });

  it('uses gpt-4o limits for hosted OpenAI', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    expect(getLlmLimits()).toEqual({ contextTokens: 128_000, maxOutputTokens: 16_384 });
  });

  it('stays conservative for a custom LLM_BASE_URL, even with a key', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    process.env.LLM_BASE_URL = 'http://my-llm:8000/v1';
    expect(getLlmLimits()).toEqual({ contextTokens: 32_768, maxOutputTokens: 8_192 });
  });
});

describe('getLlmLimits overrides', () => {
  it('reads LLM_CONTEXT_TOKENS and LLM_MAX_OUTPUT_TOKENS', () => {
    process.env.LLM_CONTEXT_TOKENS = '16384';
    process.env.LLM_MAX_OUTPUT_TOKENS = '2000';
    expect(getLlmLimits()).toEqual({ contextTokens: 16_384, maxOutputTokens: 2_000 });
  });

  it.each(['', '  ', 'abc', '0', '-5', '1.5'])('falls back to the default for %j', (bad) => {
    process.env.LLM_CONTEXT_TOKENS = bad;
    process.env.LLM_MAX_OUTPUT_TOKENS = bad;
    expect(getLlmLimits()).toEqual({ contextTokens: 32_768, maxOutputTokens: 8_192 });
  });

  it('follows VLLM_CHAT_MAX_MODEL_LEN when LLM_CONTEXT_TOKENS is unset', () => {
    // One number configures both the bundled vLLM's --max-model-len (docker-compose.ai.yml)
    // and this app, without relying on Compose to resolve a nested ${VAR:-${VAR2:-}}.
    process.env.VLLM_CHAT_MAX_MODEL_LEN = '65536';
    expect(getLlmLimits()).toEqual({ contextTokens: 65_536, maxOutputTokens: 8_192 });
  });

  it('prefers an explicit LLM_CONTEXT_TOKENS over VLLM_CHAT_MAX_MODEL_LEN', () => {
    process.env.LLM_CONTEXT_TOKENS = '16384';
    process.env.VLLM_CHAT_MAX_MODEL_LEN = '65536';
    expect(getLlmLimits().contextTokens).toBe(16_384);
  });

  it('falls back past an invalid VLLM_CHAT_MAX_MODEL_LEN to the default', () => {
    process.env.VLLM_CHAT_MAX_MODEL_LEN = 'not-a-number';
    expect(getLlmLimits().contextTokens).toBe(32_768);
  });
});

describe('transcriptBudgetChars — hosted OpenAI (no tokenizer endpoint)', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-x';
  });

  it('falls back to the 2.5 chars/token estimate for both the fixed prompt and the sample', async () => {
    // 1000 fixed chars / 2.5 = 400 tokens; sample "x".repeat(2500) / 2.5 = 1000 tokens →
    // 2.5 chars/token ratio; (10000 - 2000 - 400) * 2.5 = 19000
    const budget = await transcriptBudgetChars('x'.repeat(1000), 'x'.repeat(2500), {
      contextTokens: 10_000,
      maxOutputTokens: 2_000,
    });
    expect(budget).toBe(19_000);
  });

  it('can be negative when the context is too small', async () => {
    const budget = await transcriptBudgetChars('', '', { contextTokens: 1_000, maxOutputTokens: 2_000 });
    expect(budget).toBeLessThan(0);
  });

  it('never calls out to a tokenizer endpoint', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await transcriptBudgetChars('fixed text', 'transcript text', {
      contextTokens: 10_000,
      maxOutputTokens: 2_000,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('transcriptBudgetChars — self-hosted vLLM (exact tokenizer)', () => {
  // No OPENAI_API_KEY, no LLM_BASE_URL → self-hosted vLLM, so countTokensExact() calls out.

  function mockTokenize(countFor: (text: string) => number) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { prompt: string };
        return {
          ok: true,
          json: async () => ({ count: countFor(body.prompt) }),
        };
      }),
    );
  }

  it('uses the exact token count from the tokenizer instead of the chars/token guess', async () => {
    // Real tokenizer says the fixed prompt is 100 tokens (not 1000/2.5=400 as the guess
    // would say) and the transcript sample of 3000 chars is 1500 tokens (2 chars/token —
    // worse than the 2.5 fallback, exercising a case the old guess would get wrong).
    mockTokenize((text) => (text.includes('SAMPLE') ? 1_500 : 100));

    const sample = 'x'.repeat(2994) + 'SAMPLE'; // 3000 chars total
    const budget = await transcriptBudgetChars('fixed prompt', sample, {
      contextTokens: 10_000,
      maxOutputTokens: 2_000,
    });

    // (10000 - 2000 - 100) tokens * (3000 chars / 1500 tokens) = 15800
    expect(sample.length).toBe(3_000);
    expect(budget).toBe(15_800);
  });

  it('falls back to the chars/token estimate when the tokenizer call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

    const budget = await transcriptBudgetChars('x'.repeat(1000), 'x'.repeat(2500), {
      contextTokens: 10_000,
      maxOutputTokens: 2_000,
    });

    expect(budget).toBe(19_000);
  });

  it('falls back to the chars/token estimate when the tokenizer is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const budget = await transcriptBudgetChars('x'.repeat(1000), 'x'.repeat(2500), {
      contextTokens: 10_000,
      maxOutputTokens: 2_000,
    });

    expect(budget).toBe(19_000);
  });
});

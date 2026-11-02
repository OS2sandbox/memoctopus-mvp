import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CHAT_TEMPLATE_TOKENS,
  charsPerToken,
  countTokens,
  getLlmLimits,
  promptRoomTokens,
  transcriptBudgetChars,
} from './llm-limits';

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

  it("keeps its self-hosted default window in step with docker-compose.ai.yml's", () => {
    const compose = readFileSync(path.join(process.cwd(), 'docker-compose.ai.yml'), 'utf8');
    expect(compose).toContain(`--max-model-len=\${VLLM_CHAT_MAX_MODEL_LEN:-${getLlmLimits().contextTokens}}`);
  });

  it('falls back past an invalid VLLM_CHAT_MAX_MODEL_LEN to the default', () => {
    process.env.VLLM_CHAT_MAX_MODEL_LEN = 'not-a-number';
    expect(getLlmLimits().contextTokens).toBe(32_768);
  });
});

describe('countTokens — hosted OpenAI (no tokenizer endpoint)', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-x';
  });

  it('estimates at a pessimistic 2.5 chars/token', async () => {
    expect(await countTokens('x'.repeat(1000))).toBe(400);
    expect(await countTokens('x'.repeat(1001))).toBe(401); // rounds up
  });

  it('is 0 for empty text', async () => {
    expect(await countTokens('')).toBe(0);
  });

  it('never calls out to a tokenizer endpoint', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await countTokens('transcript text');

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('countTokens — self-hosted vLLM (exact tokenizer)', () => {
  // No OPENAI_API_KEY, no LLM_BASE_URL → self-hosted vLLM, so countTokensExact() calls out.

  it('uses the exact count from the tokenizer instead of the estimate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ count: 1_500 }) })));

    expect(await countTokens('x'.repeat(3_000))).toBe(1_500);
  });

  it('falls back to the estimate when the tokenizer call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

    expect(await countTokens('x'.repeat(1000))).toBe(400);
  });

  it('falls back to the estimate when the tokenizer is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    expect(await countTokens('x'.repeat(1000))).toBe(400);
  });
});

describe('budget arithmetic', () => {
  it('charsPerToken is the measured ratio, or the fallback for an empty count', () => {
    expect(charsPerToken('x'.repeat(3000), 1500)).toBe(2);
    expect(charsPerToken('', 0)).toBe(2.5);
  });

  it('promptRoomTokens reserves the output, the fixed prompt and the chat template', () => {
    expect(promptRoomTokens(400, { contextTokens: 10_000, maxOutputTokens: 2_000 })).toBe(
      10_000 - 2_000 - 400 - CHAT_TEMPLATE_TOKENS,
    );
  });

  it('promptRoomTokens can be negative when the context is too small', () => {
    expect(promptRoomTokens(0, { contextTokens: 1_000, maxOutputTokens: 2_000 })).toBeLessThan(0);
  });

  it('transcriptBudgetChars converts tokens to characters with a 10% margin', () => {
    // 7000 tokens × 2 chars/token = 14000 chars, less 10%.
    expect(transcriptBudgetChars(7_000, 2)).toBe(12_600);
  });
});

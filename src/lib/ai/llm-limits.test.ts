import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLlmLimits, transcriptBudgetChars } from './llm-limits';

const ENV = process.env;

beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_CONTEXT_TOKENS;
  delete process.env.LLM_MAX_OUTPUT_TOKENS;
  delete process.env.VLLM_CHAT_MAX_MODEL_LEN;
});

afterEach(() => {
  process.env = ENV;
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

describe('transcriptBudgetChars', () => {
  it('subtracts output and fixed-prompt tokens, then converts to characters', () => {
    // 1000 fixed chars / 2.5 = 400 tokens; (10000 - 2000 - 400) * 2.5 = 19000
    expect(transcriptBudgetChars(1000, { contextTokens: 10_000, maxOutputTokens: 2_000 })).toBe(19_000);
  });

  it('can be negative when the context is too small', () => {
    expect(transcriptBudgetChars(0, { contextTokens: 1_000, maxOutputTokens: 2_000 })).toBeLessThan(0);
  });
});

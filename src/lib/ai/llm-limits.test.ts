import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLlmLimits, transcriptBudgetChars, CHARS_PER_TOKEN } from './llm-limits';

const ENV = process.env;

beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_CONTEXT_TOKENS;
  delete process.env.LLM_MAX_OUTPUT_TOKENS;
});

afterEach(() => {
  process.env = ENV;
});

describe('getLlmLimits defaults', () => {
  it('is conservative for self-hosted (no key, no base URL)', () => {
    expect(getLlmLimits()).toEqual({ contextTokens: 32_768, maxOutputTokens: 4_096 });
  });

  it('uses gpt-4o limits for hosted OpenAI', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    expect(getLlmLimits()).toEqual({ contextTokens: 128_000, maxOutputTokens: 16_384 });
  });

  it('stays conservative for a custom LLM_BASE_URL, even with a key', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    process.env.LLM_BASE_URL = 'http://my-llm:8000/v1';
    expect(getLlmLimits()).toEqual({ contextTokens: 32_768, maxOutputTokens: 4_096 });
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
    expect(getLlmLimits()).toEqual({ contextTokens: 32_768, maxOutputTokens: 4_096 });
  });
});

describe('transcriptBudgetChars', () => {
  it('subtracts output and fixed-prompt tokens, then converts to characters', () => {
    process.env.LLM_CONTEXT_TOKENS = '10000';
    process.env.LLM_MAX_OUTPUT_TOKENS = '2000';
    // 1000 fixed chars / 2.5 = 400 tokens; (10000 - 2000 - 400) * 2.5 = 19000
    expect(CHARS_PER_TOKEN).toBe(2.5);
    expect(transcriptBudgetChars(1000)).toBe(19_000);
  });

  it('can be negative when the context is too small', () => {
    process.env.LLM_CONTEXT_TOKENS = '1000';
    process.env.LLM_MAX_OUTPUT_TOKENS = '2000';
    expect(transcriptBudgetChars(0)).toBeLessThan(0);
  });
});

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

import { llmModel, getLlmClient, resetLlmClient } from './llm-client';

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

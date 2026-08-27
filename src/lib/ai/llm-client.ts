import OpenAI from 'openai';

// Shared chat-LLM backend for minutes / PII / chapters / clarifications.
//
// Backend selection (precedence):
//   1. LLM_BASE_URL set        → use it (any OpenAI-compatible endpoint), with LLM_MODEL
//   2. OPENAI_API_KEY set       → hosted OpenAI (the caller's gpt-* model)
//   3. neither                  → self-hosted vLLM (Qwen) at vllm-chat:8000
//
// So a deploy "just works" against OpenAI the moment a key is supplied, and falls
// back to the self-hosted model when no key is configured (offline / data residency).
// LLM_MODEL overrides the model id in every case.

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const VLLM_BASE_URL = 'http://vllm-chat:8000/v1';
const VLLM_MODEL = 'Qwen/Qwen3.6-27B';

function hasOpenAIKey(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim();
}

// A hosted/OpenAI-compatible API is in use when a base URL is set explicitly or an
// API key is configured; otherwise we fall back to the self-hosted vLLM default.
function usingHostedApi(): boolean {
  return !!process.env.LLM_BASE_URL?.trim() || hasOpenAIKey();
}

function llmBaseURL(): string {
  const explicit = process.env.LLM_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return hasOpenAIKey() ? OPENAI_BASE_URL : VLLM_BASE_URL;
}

// Resolve the model id. LLM_MODEL always wins; otherwise use the caller's preferred
// hosted model (e.g. gpt-4o) when on a hosted API, or the single self-hosted model.
export function llmModel(hostedModel: string): string {
  return process.env.LLM_MODEL?.trim() || (usingHostedApi() ? hostedModel : VLLM_MODEL);
}

// Memoised per base URL so connection pooling is reused, but a config change (e.g. in
// tests, or a redeploy that adds a key) rebuilds the client against the new backend.
let client: OpenAI | null = null;
let clientBaseURL: string | null = null;

export function getLlmClient(): OpenAI {
  const baseURL = llmBaseURL();
  if (!client || clientBaseURL !== baseURL) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'no-key', baseURL });
    clientBaseURL = baseURL;
  }
  return client;
}

// Test seam: drop the memoised client so the next getLlmClient() re-selects the backend.
export function resetLlmClient(): void {
  client = null;
  clientBaseURL = null;
}

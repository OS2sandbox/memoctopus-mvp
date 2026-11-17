import OpenAI from 'openai';

// Shared chat-LLM backend for minutes / PII / chapters / clarifications.
//
// Backend selection (precedence):
//   1. LLM_BASE_URL set        → use it (any OpenAI-compatible endpoint), with LLM_MODEL
//   2. OPENAI_API_KEY set       → hosted OpenAI (the caller's gpt-* model)
//   3. neither                  → the bundled vLLM (docker-compose.ai.yml) at vllm-chat:8000
//
// So a deploy "just works" against OpenAI the moment a key is supplied, and falls
// back to the self-hosted model when no key is configured (offline / data residency).
// LLM_MODEL overrides the model id in every case.

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const VLLM_BASE_URL = 'http://vllm-chat:8000/v1';
// What the bundled vLLM serves when VLLM_MODEL is unset. Must equal the default in
// docker-compose.ai.yml's `--model=${VLLM_MODEL:-…}` (llm-client.test.ts checks).
export const DEFAULT_VLLM_MODEL = 'google/gemma-4-12b-it';

function hasOpenAIKey(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim();
}

// A hosted/OpenAI-compatible API is in use when a base URL is set explicitly or an
// API key is configured; otherwise we fall back to the self-hosted vLLM default.
function usingHostedApi(): boolean {
  return !!process.env.LLM_BASE_URL?.trim() || hasOpenAIKey();
}

// True when the app talks to the bundled vLLM (vllm-chat in docker-compose.ai.yml).
export function usingBundledVllm(): boolean {
  return !usingHostedApi();
}

// True only for the real OpenAI API: a key is set and no custom base URL redirects it.
// Distinct from usingHostedApi(), which is also true for any custom LLM_BASE_URL.
export function usingHostedOpenAI(): boolean {
  return hasOpenAIKey() && !process.env.LLM_BASE_URL?.trim();
}

// Extra request fields for the bundled vLLM only: switch the chat template's thinking mode
// off. A reasoning model (Qwen3 and the like) otherwise spends max_tokens on a hidden
// thinking block first and can come back with an empty answer. Hosted OpenAI rejects
// unknown request fields, and a custom LLM_BASE_URL may be any server, so neither gets it.
// Templates without the switch ignore it.
export function bundledVllmChatParams(): { chat_template_kwargs?: { enable_thinking: boolean } } {
  return usingBundledVllm() ? { chat_template_kwargs: { enable_thinking: false } } : {};
}

function llmBaseURL(): string {
  const explicit = process.env.LLM_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return hasOpenAIKey() ? OPENAI_BASE_URL : VLLM_BASE_URL;
}

// Resolve the model id. LLM_MODEL always wins; otherwise use the caller's preferred
// hosted model (e.g. gpt-4o) when on a hosted API, or whatever the bundled vLLM serves:
// VLLM_MODEL is the same variable that sets its --model, so the two cannot drift apart.
export function llmModel(hostedModel: string): string {
  const explicit = process.env.LLM_MODEL?.trim();
  if (explicit) return explicit;
  if (usingHostedApi()) return hostedModel;
  return process.env.VLLM_MODEL?.trim() || DEFAULT_VLLM_MODEL;
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

// vLLM's OpenAI-compatible server exposes exact token counting at POST /tokenize — mounted
// at the server root, not under /v1. Real OpenAI has no equivalent public endpoint, so this
// only works against vLLM (bundled or a custom LLM_BASE_URL that speaks the same API).
const TOKENIZE_TIMEOUT_MS = 10_000;

function tokenizeURL(): string {
  return llmBaseURL().replace(/\/v1\/?$/, '') + '/tokenize';
}

// Exact token count for `text` against the configured model, via vLLM's tokenizer. Returns
// null when the backend is hosted OpenAI (no tokenizer endpoint) or the call fails for any
// reason (network error, timeout, older vLLM without /tokenize, non-vLLM LLM_BASE_URL) —
// callers fall back to an estimate in that case.
export async function countTokensExact(text: string): Promise<number | null> {
  if (usingHostedOpenAI()) return null;
  try {
    const res = await fetch(tokenizeURL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: llmModel('gpt-4o'), prompt: text }),
      // Counting takes milliseconds. A tokenizer that does not answer must not hold up
      // minutes generation: give up and use the estimate.
      signal: AbortSignal.timeout(TOKENIZE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.count === 'number' ? data.count : null;
  } catch {
    return null;
  }
}

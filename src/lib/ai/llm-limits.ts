import { usingHostedOpenAI } from './llm-client';

// Context-window budgeting for chat-LLM calls (minutes generation).
//
// LLM_CONTEXT_TOKENS / LLM_MAX_OUTPUT_TOKENS describe the model the deployment points at.
// Real OpenAI gets gpt-4o's limits; any other endpoint (self-hosted vLLM, a custom
// LLM_BASE_URL) gets conservative defaults because its real window is unknown — operators
// with a different model set the variables. Env is read inside the function so a change
// takes effect on restart without a rebuild.

// Deliberately pessimistic for Danish (measured 2.33–2.97 chars/token; names, numbers and
// loanwords tokenise worse). Summarising a transcript that would have fit costs some
// quality; exceeding the window costs the whole request.
const CHARS_PER_TOKEN = 2.5;

interface LlmLimits {
  contextTokens: number;
  maxOutputTokens: number;
}

function positiveInt(raw: string | undefined): number | null {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function getLlmLimits(): LlmLimits {
  const hosted = usingHostedOpenAI();
  return {
    // VLLM_CHAT_MAX_MODEL_LEN also sets the bundled vLLM's own --max-model-len (see
    // docker-compose.ai.yml), so one number configures both it and this fallback — the
    // app reads both env vars itself rather than relying on Compose to resolve a
    // ${VAR:-${VAR2:-}} nested substitution, which not every Compose version does.
    contextTokens:
      positiveInt(process.env.LLM_CONTEXT_TOKENS) ??
      positiveInt(process.env.VLLM_CHAT_MAX_MODEL_LEN) ??
      (hosted ? 128_000 : 32_768),
    maxOutputTokens: positiveInt(process.env.LLM_MAX_OUTPUT_TOKENS) ?? (hosted ? 16_384 : 8_192),
  };
}

// Characters of transcript that fit in one call, given the length of everything else in
// the prompt (system prompt, instruction, wrapper text). May be negative for a
// misconfigured (too small) context.
export function transcriptBudgetChars(fixedPromptChars: number, limits: LlmLimits): number {
  const { contextTokens, maxOutputTokens } = limits;
  const fixedTokens = Math.ceil(fixedPromptChars / CHARS_PER_TOKEN);
  return Math.floor((contextTokens - maxOutputTokens - fixedTokens) * CHARS_PER_TOKEN);
}

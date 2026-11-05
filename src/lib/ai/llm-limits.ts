import { usingBundledVllm, usingHostedOpenAI, countTokensExact } from './llm-client';

// Context-window budgeting for chat-LLM calls (minutes generation).
//
// LLM_CONTEXT_TOKENS / LLM_MAX_OUTPUT_TOKENS describe the model the deployment points at.
// Real OpenAI gets gpt-4o's limits; any other endpoint (self-hosted vLLM, a custom
// LLM_BASE_URL) gets conservative defaults because its real window is unknown — operators
// with a different model set the variables. Env is read inside the function so a change
// takes effect on restart without a rebuild.

// Fallback only: used when no exact token count is available (real OpenAI, which has no
// tokenizer endpoint; or a vLLM call that failed). Deliberately pessimistic for Danish
// (measured 2.33–2.97 chars/token; names, numbers and loanwords tokenise worse).
// Summarising a transcript that would have fit costs some quality; exceeding the window
// costs the whole request.
const CHARS_PER_TOKEN_FALLBACK = 2.5;

export interface LlmLimits {
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
    // ${VAR:-${VAR2:-}} nested substitution, which not every Compose version does. It
    // describes the bundled vLLM only, so any other backend ignores it.
    contextTokens:
      positiveInt(process.env.LLM_CONTEXT_TOKENS) ??
      (usingBundledVllm() ? positiveInt(process.env.VLLM_CHAT_MAX_MODEL_LEN) : null) ??
      (hosted ? 128_000 : 32_768),
    maxOutputTokens: positiveInt(process.env.LLM_MAX_OUTPUT_TOKENS) ?? (hosted ? 16_384 : 8_192),
  };
}

// Tokens the chat template wraps around the messages (role markers, BOS, the generation
// prompt) that /tokenize on a bare prompt does not see. A handful per message on the
// models we ship; generous, because some templates inject a default preamble too.
export const CHAT_TEMPLATE_TOKENS = 128;

// Share of the room held back when turning a token budget into a character budget for
// splitting. The chars/token ratio is the whole transcript's; a stretch of short turns
// (a speaker header every few words) tokenises denser than that, so a part cut to the
// average would overflow. The parts are still checked exactly afterwards; this keeps
// the re-splitting rare.
const SPLIT_SAFETY = 0.1;

// Token count for `text` against the configured model: exact via vLLM's /tokenize, or
// the pessimistic chars/token estimate when no tokenizer endpoint is available.
export async function countTokens(text: string): Promise<number> {
  if (!text) return 0;
  const exact = await countTokensExact(text);
  return exact ?? Math.ceil(text.length / CHARS_PER_TOKEN_FALLBACK);
}

// Characters per token of `text`, given its token count (from countTokens). Converts a
// token budget into the character budget the splitter works in.
export function charsPerToken(text: string, tokens: number): number {
  return tokens > 0 ? text.length / tokens : CHARS_PER_TOKEN_FALLBACK;
}

// Tokens left for transcript text in one call, after the output reservation, the fixed
// part of the prompt (system prompt, instruction, wrapper text) and the chat template.
// May be negative for a misconfigured (too small) context.
export function promptRoomTokens(fixedTokens: number, limits: LlmLimits): number {
  return limits.contextTokens - limits.maxOutputTokens - fixedTokens - CHAT_TEMPLATE_TOKENS;
}

// Characters of transcript to aim for in a call with `roomTokens` of space, at the
// transcript's measured `charsPerToken`, less a safety margin. Pure; may be negative.
export function transcriptBudgetChars(roomTokens: number, charsPerTokenRatio: number): number {
  return Math.floor(roomTokens * charsPerTokenRatio * (1 - SPLIT_SAFETY));
}

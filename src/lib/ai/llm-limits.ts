import { usingHostedOpenAI, countTokensExact } from './llm-client';

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

// Exact token count for `text` against the configured model, via vLLM's /tokenize. Falls
// back to the pessimistic chars/token estimate when no tokenizer endpoint is available.
async function countTokens(text: string): Promise<number> {
  if (!text) return 0;
  const exact = await countTokensExact(text);
  return exact ?? Math.ceil(text.length / CHARS_PER_TOKEN_FALLBACK);
}

// Characters of transcript that fit in one call, given the fixed part of the prompt (system
// prompt, instruction, wrapper text) and a sample of the transcript itself.
//
// `fixedPromptText` and `transcriptSample` are both tokenised exactly via the model's own
// tokenizer where available (vLLM), rather than guessed from a fixed chars/token constant.
// The sample's measured chars/token ratio — exact for this transcript's actual text, not a
// hardcoded average — is what converts the remaining token budget back to a character count
// for the splitting logic downstream, which still operates on characters. May be negative
// for a misconfigured (too small) context.
export async function transcriptBudgetChars(
  fixedPromptText: string,
  transcriptSample: string,
  limits: LlmLimits,
): Promise<number> {
  const { contextTokens, maxOutputTokens } = limits;
  const [fixedTokens, sampleTokens] = await Promise.all([
    countTokens(fixedPromptText),
    countTokens(transcriptSample),
  ]);
  const charsPerToken =
    sampleTokens > 0 ? transcriptSample.length / sampleTokens : CHARS_PER_TOKEN_FALLBACK;
  return Math.floor((contextTokens - maxOutputTokens - fixedTokens) * charsPerToken);
}

// Prompt sizing for the chat LLM.
//
// The app talks to whatever `LLM_BASE_URL` points at, so nothing here can know the
// real context window — it is configuration, not detection. Every value is read from
// `process.env` inside a function (the same idiom as `llm-client.ts`) so an operator
// changes `.env` and restarts, with no rebuild.
//
// Why this exists: a fixed character threshold has no relationship to the model
// actually in use. It happens to be about right for a large hosted model and is badly
// wrong for a small self-hosted one, where a long meeting either fails outright or is
// silently truncated mid-sentence (issue #97).

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function envFloat(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// The model's context window in tokens. Defaults to the 65536 this repo's own vLLM
// service is started with (see docker-compose.vllm.yml); a deployment pointing at a
// smaller model (e.g. gemma on `--max-model-len 16384`) must set this or long
// meetings will overflow.
export function contextWindowTokens(): number {
  return envInt('LLM_CONTEXT_TOKENS', 65_536);
}

// Hard cap on the referat itself, passed as `max_tokens`. Without it the model gets
// "whatever is left of the window", which is small exactly when the prompt is large —
// so the referat is cut off mid-sentence with no error raised.
export function maxOutputTokens(): number {
  return envInt('LLM_MAX_OUTPUT_TOKENS', 2_000);
}

// Cap for one chapter summary. These are bullet lists, so they need far less room
// than the referat.
export function chapterSummaryMaxTokens(): number {
  return envInt('LLM_CHAPTER_SUMMARY_MAX_TOKENS', 500);
}

// Room set aside for the system prompt, the skabelon instruction and the fixed
// wrapper text around the transcript.
export function promptReserveTokens(): number {
  return envInt('LLM_PROMPT_RESERVE_TOKENS', 1_000);
}

// Deliberately pessimistic: Danish tokenizes poorly against these models, and names,
// numbers and loanwords are worse than average prose. Under-estimating costs some
// summarisation quality on a transcript that would just have fit; over-estimating
// costs the whole request.
export function charsPerToken(): number {
  return envFloat('LLM_CHARS_PER_TOKEN', 2.5);
}

// Never go below this, however the window is configured. A budget at or near zero
// would send the model an empty transcript and nothing but the truncation marker —
// and it would dutifully invent a referat from nothing, which is far worse than a
// request that fails. A misconfiguration should be loud, not quietly fabricated.
const MIN_TRANSCRIPT_BUDGET_CHARS = 2_000;

// How many characters of transcript can be sent while leaving room for the output and
// the surrounding prompt.
export function transcriptBudgetChars(): number {
  const usable = contextWindowTokens() - maxOutputTokens() - promptReserveTokens();
  const derived = Math.floor(usable * charsPerToken());
  if (derived < MIN_TRANSCRIPT_BUDGET_CHARS) {
    // Warned every time rather than once: this only fires on a misconfiguration, and
    // referat generation is not a hot path, so a repeated log costs nothing and avoids
    // module-level state (plus the test seam it would need).
    console.warn(
      `[minutes] LLM_CONTEXT_TOKENS=${contextWindowTokens()} leaves only ${derived} ` +
      `characters for the transcript after output (${maxOutputTokens()}) and reserve ` +
      `(${promptReserveTokens()}) tokens. Using ${MIN_TRANSCRIPT_BUDGET_CHARS}; the ` +
      'request will likely exceed the window. Raise the context window or lower the caps.',
    );
    return MIN_TRANSCRIPT_BUDGET_CHARS;
  }
  return derived;
}

// Character length above which chaptered transcripts are summarised per chapter
// rather than sent whole. This is a *quality* heuristic — condensing keeps the referat
// focused — and is independent of what the window can physically hold, so the budget
// above is applied on top of it.
export function chapterSplitChars(): number {
  return envInt('LLM_CHAPTER_SPLIT_CHARS', 20_000);
}

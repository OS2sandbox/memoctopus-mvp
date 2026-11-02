import type OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { TranscriptSegment } from '@/types';
import { TranscriptChapter } from '@/lib/ai/chapters';
import { bundledVllmChatParams, getLlmClient, llmModel } from './llm-client';
import {
  charsPerToken,
  countTokens,
  getLlmLimits,
  promptRoomTokens,
  transcriptBudgetChars,
} from './llm-limits';
import { mapWithLimit } from './map-with-limit';
import { MinutesConfigError, MinutesTooLongError, MinutesTruncatedError } from './minutes-errors';
import { mergeSpeakerTurns, packTurns, renderTurns, type Turn } from './transcript-text';

const MINUTES_SYSTEM_PROMPT = `Du er en dansk mødesekretær der udarbejder professionelle mødereferater.

Du skriver:
- Klart og præcist dansk (ikke bureaukratisk, men formelt)
- I tredje person ("Mødet besluttede...", "Parterne aftalte...")
- Fokuseret på det væsentlige — ikke alt hvad der blev sagt
- Med respekt for mødets karakter og kontekst

Brugerens instruktioner og de ønskede afsnit er styrende: følg dem nøje — også den ønskede længde — og tilføj ikke afsnit (fx beslutninger eller resumé) eller indhold der ikke er bedt om.

Du skriver referatet som ét sammenhængende dokument i markdown.`;

// Transcript char length above which per-chapter summarisation is used (~30–60 min meeting)
const CHAPTER_SPLIT_THRESHOLD = 20_000;

// At most this many summarise passes (the first counts as pass 1) before giving up.
const MAX_SUMMARY_ROUNDS = 3;

// Concurrent summary calls. The bundled vLLM runs with --max-num-seqs 4.
const SUMMARY_CONCURRENCY = 3;

// Concurrent /tokenize calls when checking parts. Cheap next to a completion.
const TOKENIZE_CONCURRENCY = 8;

// Output cap for a per-part summary (max 8 bullet points).
const SUMMARY_MAX_OUTPUT_TOKENS = 1_024;

// Below this many characters of transcript budget the configuration cannot work.
const MIN_TRANSCRIPT_BUDGET_CHARS = 4_000;

// The generation-relevant subset of a Skabelon.
export interface SkabelonSpec {
  prompt: string;
  includeDeltagere: boolean;
  includeBeslutningspunkter: boolean;
  includeDagsorden: boolean;
  includeDato: boolean;
}

// ─── Prompt building ──────────────────────────────────────────────────────────

export function buildSkabelonInstruction(
  spec: SkabelonSpec,
  participants?: string[],
  customPrompt?: string,
): string {
  const parts: string[] = [];
  if (spec.prompt.trim()) parts.push(spec.prompt.trim());

  const categories: string[] = [];
  // The "Dato" tag no longer injects the date into the body — the date lives in
  // the editable document header (see MinutesContent.header) so it isn't rendered
  // twice. `spec.includeDato` is consumed at save time to populate that header.
  if (spec.includeDagsorden) {
    categories.push('- En **Dagsorden**-sektion med mødets punkter.');
  }
  if (spec.includeDeltagere) {
    const names =
      participants && participants.length > 0 ? ` Deltagere: ${participants.join(', ')}.` : '';
    categories.push(`- En **Deltagere**-sektion med mødets deltagere.${names}`);
  }
  if (spec.includeBeslutningspunkter) {
    categories.push('- En **Beslutningspunkter**-sektion der opsummerer de trufne beslutninger.');
  }
  if (categories.length > 0) {
    parts.push(
      'Strukturér referatet med følgende afsnit, og medtag ikke yderligere faste afsnit (fx beslutninger eller resumé) medmindre instruktionen nedenfor beder om det:\n' +
        categories.join('\n'),
    );
  } else if (participants && participants.length > 0) {
    parts.push(`Deltagere i mødet: ${participants.join(', ')}.`);
  }

  if (customPrompt && customPrompt.trim()) {
    parts.push('Følg denne instruktion nøje: ' + customPrompt.trim());
  }
  return parts.join('\n\n');
}

// ─── Generation ───────────────────────────────────────────────────────────────

// A 400 from the model saying the request does not fit its window. vLLM and OpenAI both
// word it "maximum context length" (vLLM's engine-level check says "maximum model
// length"); OpenAI also sets code context_length_exceeded. Matched on the error's shape
// rather than the SDK's error class, so it holds across SDK versions and a mocked client.
function isContextLengthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { status, code, message } = err as { status?: unknown; code?: unknown; message?: unknown };
  if (status !== 400) return false;
  return (
    code === 'context_length_exceeded' ||
    /maximum context length|maximum model length/i.test(String(message ?? ''))
  );
}

type ChatParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

// Every chat call minutes generation makes. The budgeting below keeps requests inside the
// window, but a misconfigured LLM_CONTEXT_TOKENS (larger than the model's real window) can
// still overflow it: the user then gets the "too long" message, not a generic server error.
async function complete(params: ChatParams): Promise<ChatCompletion> {
  try {
    return await getLlmClient().chat.completions.create({ ...params, ...bundledVllmChatParams() });
  } catch (err) {
    if (isContextLengthError(err)) {
      throw new MinutesTooLongError(
        `The model rejected the request as longer than its context window: ${(err as Error).message}`,
      );
    }
    throw err;
  }
}

// Keep the transcript last: also called with '' to measure the fixed part of the prompt.
function buildBodyPrompt(transcriptText: string, instruction: string): string {
  return `Udarbejd et mødereferat baseret på denne transskription.
${instruction ? `\n${instruction}\n` : ''}
Følg instruktionerne ovenfor nøje — herunder ønsket længde og hvilke afsnit der skal med. Skriv referatet som ét sammenhængende dokument i markdown. Brug overskrifter (##) til afsnit og punktlister hvor det er relevant. Returner KUN selve referatet — ingen forklaringer, ingen JSON og ingen code blocks.

Transskription:
${transcriptText}`;
}

async function _generateBody(
  transcriptText: string,
  instruction: string,
  maxOutputTokens: number,
): Promise<string> {
  const response = await complete({
    model: llmModel('gpt-4o'),
    max_tokens: maxOutputTokens,
    messages: [
      { role: 'system', content: MINUTES_SYSTEM_PROMPT },
      { role: 'user', content: buildBodyPrompt(transcriptText, instruction) },
    ],
  });

  // A call that runs out of output tokens returns a cut-off document with no error. Never
  // hand that to the user as if it were a complete referat.
  if (response.choices[0]?.finish_reason === 'length') {
    throw new MinutesTruncatedError('The model hit its output limit while writing the referat');
  }
  const raw = response.choices[0]?.message?.content ?? '';
  // Strip an accidental markdown code fence if the model wraps the document.
  return raw
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

// Keep the text last: also called with '' to measure the fixed part of the prompt.
function buildSummaryPrompt(text: string, title: string): string {
  return `Opsummer mødeafsnittet "${title}" i korte punkter på dansk (max 8 punkter). Fokus på beslutninger, aftaler og vigtige diskussionspunkter.

${text}

Returner kun en punktliste.`;
}

async function _summarizePart(text: string, title: string): Promise<string> {
  const response = await complete({
    model: llmModel('gpt-4o'),
    max_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: buildSummaryPrompt(text, title) }],
  });

  const finishReason = response.choices[0]?.finish_reason;
  const summary = response.choices[0]?.message?.content?.trim();
  // Nothing at all is not a summary: written up as an empty section, that part of the
  // meeting would silently vanish from the referat. Typically a reasoning model that spent
  // its whole cap thinking (finish_reason "length").
  if (!summary) {
    throw new Error(
      `[minutes] the model returned an empty summary for "${title}" (finish_reason=${finishReason ?? 'none'})`,
    );
  }
  // A summary cut off at its cap is still a usable (slightly shorter) bullet list, and it
  // is only an input to the referat — failing the whole meeting over it would be worse.
  if (finishReason === 'length') {
    console.warn(`[minutes] summary of "${title}" hit its ${SUMMARY_MAX_OUTPUT_TOKENS}-token cap`);
  }
  return summary;
}

// A stretch of the meeting to summarise: a chapter, or the whole transcript.
interface Unit {
  title: string;
  turns: Turn[];
}

// How much one summary call may hold. `budgetChars` is the first guess at a part's size,
// from the transcript's average chars/token; `promptTokens` is the hard limit every
// summary prompt is checked against.
interface SummaryBudget {
  budgetChars: number;
  promptTokens: number;
}

const partHeading = (title: string, i: number, n: number) =>
  n > 1 ? `${title} (del ${i + 1}/${n})` : title;

// The token check uses the widest "(del i/n)" suffix: the real one is not known until the
// unit's parts are final, and it must not tip a checked part over the limit.
const WIDEST_PART_SUFFIX = ' (del 999/999)';

// Re-pack a part this many times at most before giving up on it.
const MAX_REPACKS = 5;

// Pack turns into parts whose summary prompt — title included — fits the window, counted
// with the model's own tokenizer where there is one. The character budget is only a guess
// from the transcript's average chars/token, so a part denser than average (a run of short
// turns, each with its speaker header) is packed again with a budget scaled by how far
// over it came out.
async function packToFit(
  turns: Turn[],
  title: string,
  budgetChars: number,
  promptTokens: number,
  depth = 0,
): Promise<Turn[][]> {
  const sized = await mapWithLimit(packTurns(turns, budgetChars), TOKENIZE_CONCURRENCY, async (part) => {
    const text = renderTurns(part);
    const tokens = await countTokens(buildSummaryPrompt(text, title + WIDEST_PART_SUFFIX));
    return { part, chars: text.length, tokens };
  });

  const fitted: Turn[][] = [];
  for (const { part, chars, tokens } of sized) {
    if (tokens <= promptTokens) {
      fitted.push(part);
      continue;
    }
    const smaller = Math.floor(chars * (promptTokens / tokens) * 0.95);
    if (depth >= MAX_REPACKS || smaller < 1) {
      throw new MinutesTooLongError(
        `A summary prompt is ${tokens} tokens against a limit of ${promptTokens} after ${depth} re-packs`,
      );
    }
    fitted.push(...(await packToFit(part, title, smaller, promptTokens, depth + 1)));
  }
  return fitted;
}

// Summarise every unit, splitting any unit too large for one summary call into parts.
// Returns one markdown section per part, in meeting order. A unit with no turns (an agenda
// topic nothing was assigned to) still gets its heading, with an empty body — every
// chapter appears in the condensed text, even one nothing was said under.
async function _summarizeUnits(units: Unit[], budget: SummaryBudget): Promise<string> {
  const packed = await Promise.all(
    units.map((unit) => packToFit(unit.turns, unit.title, budget.budgetChars, budget.promptTokens)),
  );
  const jobs = units.flatMap((unit, u) => {
    const parts = packed[u];
    if (parts.length === 0) return [{ heading: unit.title, text: '' }];
    return parts.map((part, i) => ({
      heading: partHeading(unit.title, i, parts.length),
      text: renderTurns(part),
    }));
  });

  const summaries = await mapWithLimit(jobs, SUMMARY_CONCURRENCY, (job) =>
    job.text ? _summarizePart(job.text, job.heading) : Promise.resolve(''),
  );
  return jobs.map((job, i) => `## ${job.heading}\n${summaries[i]}`).join('\n\n');
}

/**
 * Generate a referat as a single markdown document, driven by a Skabelon.
 *
 * The transcript is merged into speaker turns and measured in tokens against the model's
 * context window (LLM_CONTEXT_TOKENS / LLM_MAX_OUTPUT_TOKENS) — counted with the model's
 * own tokenizer where the backend has one (vLLM), estimated otherwise. If it fits, one
 * call writes the referat. Otherwise the transcript is summarised in parts and the
 * referat is written from those summaries, so a long meeting never overflows the window
 * or comes back cut off.
 */
export async function generateReferatBody(
  transcript: TranscriptSegment[],
  spec: SkabelonSpec,
  participants?: string[],
  chapters?: TranscriptChapter[],
  customPrompt?: string,
): Promise<{ body: string }> {
  const t0 = Date.now();
  const instruction = buildSkabelonInstruction(spec, participants, customPrompt);

  const limits = getLlmLimits();
  const turns = mergeSpeakerTurns(transcript);
  const transcriptText = renderTurns(turns);

  // The transcript is tokenised once: its count decides whether it fits in one call, and
  // its chars/token ratio sizes the parts when it does not.
  const [transcriptTokens, bodyFixedTokens, summaryFixedTokens] = await Promise.all([
    countTokens(transcriptText),
    countTokens(`${MINUTES_SYSTEM_PROMPT}\n${buildBodyPrompt('', instruction)}`),
    countTokens(buildSummaryPrompt('', '')),
  ]);
  const ratio = charsPerToken(transcriptText, transcriptTokens);

  const bodyRoom = promptRoomTokens(bodyFixedTokens, limits);
  const budget = transcriptBudgetChars(bodyRoom, ratio);
  if (budget < MIN_TRANSCRIPT_BUDGET_CHARS) {
    throw new MinutesConfigError(
      `LLM_CONTEXT_TOKENS=${limits.contextTokens} leaves ${Math.max(budget, 0)} characters for the ` +
        `transcript after reserving ${limits.maxOutputTokens} output tokens ` +
        `(minimum ${MIN_TRANSCRIPT_BUDGET_CHARS}). Raise LLM_CONTEXT_TOKENS or lower LLM_MAX_OUTPUT_TOKENS.`,
    );
  }

  // _summarizePart always requests SUMMARY_MAX_OUTPUT_TOKENS, not limits.maxOutputTokens
  // (a summary needs far less room than the final referat) — so the parts it is fed are
  // sized against that smaller reservation, not the referat's.
  const summaryLimits = { contextTokens: limits.contextTokens, maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS };
  const summaryBudget: SummaryBudget = {
    budgetChars: transcriptBudgetChars(promptRoomTokens(summaryFixedTokens, summaryLimits), ratio),
    promptTokens: promptRoomTokens(0, summaryLimits),
  };
  if (summaryBudget.budgetChars < MIN_TRANSCRIPT_BUDGET_CHARS) {
    throw new MinutesConfigError(
      `LLM_CONTEXT_TOKENS=${limits.contextTokens} leaves too little room for even a part-summary ` +
        `call (reserving ${SUMMARY_MAX_OUTPUT_TOKENS} output tokens). Raise LLM_CONTEXT_TOKENS.`,
    );
  }

  const chapterList = chapters && chapters.length > 1 ? chapters : null;
  const log = (mode: string, rounds: number) =>
    console.log(
      `[minutes] chars=${transcriptText.length} tokens=${transcriptTokens} room=${bodyRoom} mode=${mode} rounds=${rounds} ms=${Date.now() - t0}`,
    );

  if (
    transcriptTokens <= bodyRoom &&
    !(chapterList !== null && transcriptText.length > CHAPTER_SPLIT_THRESHOLD)
  ) {
    const body = await _generateBody(transcriptText, instruction, limits.maxOutputTokens);
    log('single', 0);
    return { body };
  }

  const units: Unit[] = chapterList
    ? chapterList.map((ch) => ({
        title: ch.title,
        turns: mergeSpeakerTurns(ch.segmentIndices.map((i) => transcript[i]).filter(Boolean)),
      }))
    : [{ title: 'Mødet', turns }];

  let rounds = 1;
  let condensed = await _summarizeUnits(units, summaryBudget);
  let condensedTokens = await countTokens(condensed);
  while (condensedTokens > bodyRoom) {
    if (rounds >= MAX_SUMMARY_ROUNDS) {
      throw new MinutesTooLongError(
        `Still ${condensedTokens} tokens (room ${bodyRoom}) after ${rounds} summarise rounds`,
      );
    }
    rounds++;
    condensed = await _summarizeUnits(
      [{ title: 'Opsummering', turns: [{ speaker: 'Resumé', start: 0, text: condensed }] }],
      summaryBudget,
    );
    condensedTokens = await countTokens(condensed);
  }

  const body = await _generateBody(condensed, instruction, limits.maxOutputTokens);
  log('split', rounds);
  return { body };
}

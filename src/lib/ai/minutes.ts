import { TranscriptSegment } from '@/types';
import { TranscriptChapter } from '@/lib/ai/chapters';
import { getLlmClient, llmModel } from './llm-client';
import { getLlmLimits, transcriptBudgetChars } from './llm-limits';
import { mapWithLimit } from './map-with-limit';
import { MinutesConfigError, MinutesTooLongError, MinutesTruncatedError } from './minutes-errors';
import { mergeSpeakerTurns, renderTurns, splitTurns, type Turn } from './transcript-text';

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
  const response = await getLlmClient().chat.completions.create({
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
  const response = await getLlmClient().chat.completions.create({
    model: llmModel('gpt-4o'),
    max_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: buildSummaryPrompt(text, title) }],
  });

  // A summary cut off at its cap is still a usable (slightly shorter) bullet list, and it
  // is only an input to the referat — failing the whole meeting over it would be worse.
  if (response.choices[0]?.finish_reason === 'length') {
    console.warn(`[minutes] summary of "${title}" hit its ${SUMMARY_MAX_OUTPUT_TOKENS}-token cap`);
  }
  return response.choices[0]?.message?.content?.trim() ?? '';
}

// A stretch of the meeting to summarise: a chapter, or the whole transcript.
interface Unit {
  title: string;
  turns: Turn[];
}

// Summarise every unit, splitting any unit larger than `budget` into parts. Returns one
// markdown section per part, in meeting order. A unit with no turns (an agenda topic
// nothing was assigned to) still gets its heading, with an empty body — every chapter
// appears in the condensed text, even one nothing was said under.
async function _summarizeUnits(units: Unit[], budget: number): Promise<string> {
  const jobs = units.flatMap((unit) => {
    const parts = splitTurns(unit.turns, budget);
    if (parts.length === 0) return [{ heading: unit.title, text: '' }];
    return parts.map((text, i) => ({
      heading: parts.length > 1 ? `${unit.title} (del ${i + 1}/${parts.length})` : unit.title,
      text,
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
 * The transcript is merged into speaker turns and measured against a character budget
 * derived from the model's context window (LLM_CONTEXT_TOKENS / LLM_MAX_OUTPUT_TOKENS).
 * If it fits, one call writes the referat. Otherwise the transcript is summarised in
 * parts and the referat is written from those summaries, so a long meeting never
 * overflows the window or comes back cut off.
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
  const fixedChars = MINUTES_SYSTEM_PROMPT.length + buildBodyPrompt('', instruction).length;
  const budget = transcriptBudgetChars(fixedChars, limits);
  if (budget < MIN_TRANSCRIPT_BUDGET_CHARS) {
    throw new MinutesConfigError(
      `LLM_CONTEXT_TOKENS=${limits.contextTokens} leaves ${Math.max(budget, 0)} characters for the ` +
        `transcript after reserving ${limits.maxOutputTokens} output tokens ` +
        `(minimum ${MIN_TRANSCRIPT_BUDGET_CHARS}). Raise LLM_CONTEXT_TOKENS or lower LLM_MAX_OUTPUT_TOKENS.`,
    );
  }

  // _summarizePart always requests SUMMARY_MAX_OUTPUT_TOKENS, not limits.maxOutputTokens
  // (a summary needs far less room than the final referat) — so the parts it is fed have
  // to be sized against that smaller reservation, not `budget`, or the prompt plus the
  // summary's own output can together exceed the real context window.
  const summaryFixedChars = buildSummaryPrompt('', '').length;
  const summaryBudget = transcriptBudgetChars(summaryFixedChars, {
    contextTokens: limits.contextTokens,
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
  });
  if (summaryBudget < MIN_TRANSCRIPT_BUDGET_CHARS) {
    throw new MinutesConfigError(
      `LLM_CONTEXT_TOKENS=${limits.contextTokens} leaves too little room for even a part-summary ` +
        `call (reserving ${SUMMARY_MAX_OUTPUT_TOKENS} output tokens). Raise LLM_CONTEXT_TOKENS.`,
    );
  }

  const turns = mergeSpeakerTurns(transcript);
  const transcriptText = renderTurns(turns);
  const chapterList = chapters && chapters.length > 1 ? chapters : null;
  const log = (mode: string, rounds: number) =>
    console.log(
      `[minutes] chars=${transcriptText.length} budget=${budget} mode=${mode} rounds=${rounds} ms=${Date.now() - t0}`,
    );

  if (
    transcriptText.length <= budget &&
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
  while (condensed.length > budget) {
    if (rounds >= MAX_SUMMARY_ROUNDS) {
      throw new MinutesTooLongError(
        `Still ${condensed.length} characters (budget ${budget}) after ${rounds} summarise rounds`,
      );
    }
    rounds++;
    condensed = await _summarizeUnits(
      [{ title: 'Opsummering', turns: [{ speaker: 'Resumé', start: 0, text: condensed }] }],
      summaryBudget,
    );
  }

  const body = await _generateBody(condensed, instruction, limits.maxOutputTokens);
  log('split', rounds);
  return { body };
}

import { TranscriptSegment } from '@/types';
import { TranscriptChapter } from '@/lib/ai/chapters';
import { getLlmClient, llmModel } from './llm-client';
import {
  chapterSplitChars,
  chapterSummaryMaxTokens,
  maxOutputTokens,
  transcriptBudgetChars,
} from './llm-budget';

const MINUTES_SYSTEM_PROMPT = `Du er en dansk mødesekretær der udarbejder professionelle mødereferater.

Du skriver:
- Klart og præcist dansk (ikke bureaukratisk, men formelt)
- I tredje person ("Mødet besluttede...", "Parterne aftalte...")
- Fokuseret på det væsentlige — ikke alt hvad der blev sagt
- Med respekt for mødets karakter og kontekst

Brugerens instruktioner og de ønskede afsnit er styrende: følg dem nøje — også den ønskede længde — og tilføj ikke afsnit (fx beslutninger eller resumé) eller indhold der ikke er bedt om.

Du skriver referatet som ét sammenhængende dokument i markdown.`;

// Appended when a transcript has to be cut to fit the context window, so the model
// (and anyone reading the prompt in a log) knows the input is partial rather than the
// meeting having simply ended.
const TRUNCATION_MARKER = '\n\n[…] Transskriptionen er forkortet for at overholde modellens kontekstvindue.';

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

// ─── Transcript rendering ─────────────────────────────────────────────────────

/**
 * Collapse consecutive segments from the same speaker into one turn.
 *
 * hviske emits short utterances, so one person speaking for a minute becomes many
 * segments — each paying for a repeated `[Taler N] (mm:ss): ` prefix. On a measured
 * 57-minute meeting that was 982 segments against 126 real speaker turns, with ~37%
 * of the prompt's characters spent on labels rather than speech.
 *
 * The merged turn keeps the first segment's start and the last one's end, so
 * timestamps still bracket what was actually said.
 */
export function mergeConsecutiveSpeakerTurns(segments: TranscriptSegment[]): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && previous.speaker === segment.speaker) {
      previous.end = segment.end;
      previous.text = `${previous.text} ${segment.text}`.trim();
    } else {
      // Copied, so merging never mutates the caller's transcript.
      merged.push({ ...segment });
    }
  }
  return merged;
}

// Render a transcript for the prompt: one line per speaker turn, timestamped.
function renderTranscript(segments: TranscriptSegment[]): string {
  return mergeConsecutiveSpeakerTurns(segments)
    .map((s) => `[${s.speaker}] (${formatTime(s.start)}): ${s.text}`)
    .join('\n');
}

// Cut to `budget` characters on a line boundary where possible, so the prompt never
// ends mid-word. Returns the text unchanged when it already fits.
function truncateToBudget(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const room = Math.max(0, budget - TRUNCATION_MARKER.length);
  const cut = text.slice(0, room);
  const lastNewline = cut.lastIndexOf('\n');
  return (lastNewline > room * 0.5 ? cut.slice(0, lastNewline) : cut) + TRUNCATION_MARKER;
}

// ─── Generation ───────────────────────────────────────────────────────────────

async function _generateBody(transcriptText: string, instruction: string): Promise<string> {
  const response = await getLlmClient().chat.completions.create({
    model: llmModel('gpt-4o'),
    // Explicit, rather than "whatever is left of the context window" — which is
    // least when the prompt is largest, silently truncating long referats.
    max_tokens: maxOutputTokens(),
    messages: [
      { role: 'system', content: MINUTES_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Udarbejd et mødereferat baseret på denne transskription.
${instruction ? `\n${instruction}\n` : ''}
Følg instruktionerne ovenfor nøje — herunder ønsket længde og hvilke afsnit der skal med. Skriv referatet som ét sammenhængende dokument i markdown. Brug overskrifter (##) til afsnit og punktlister hvor det er relevant. Returner KUN selve referatet — ingen forklaringer, ingen JSON og ingen code blocks.

Transskription:
${transcriptText}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';
  // Strip an accidental markdown code fence if the model wraps the document.
  return raw
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

async function _summarizeChapter(
  chapterSegments: TranscriptSegment[],
  chapterTitle: string,
): Promise<string> {
  // A single chapter can be larger than the window on its own — chaptering bounds how
  // many summaries there are, not how big each one is — so the budget applies here too.
  const transcriptText = truncateToBudget(
    mergeConsecutiveSpeakerTurns(chapterSegments)
      .map((s) => `[${s.speaker}]: ${s.text}`)
      .join('\n'),
    transcriptBudgetChars(),
  );

  const response = await getLlmClient().chat.completions.create({
    model: llmModel('gpt-4o'),
    max_tokens: chapterSummaryMaxTokens(),
    messages: [
      {
        role: 'user',
        content: `Opsummer mødekapitlet "${chapterTitle}" i korte punkter på dansk (max 8 punkter). Fokus på beslutninger, aftaler og vigtige diskussionspunkter.

${transcriptText}

Returner kun en punktliste.`,
      },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ?? '';
}

/**
 * Generate a referat as a single markdown document, driven by a Skabelon.
 *
 * For long, chaptered transcripts the chapters are summarised first and the
 * referat is written from those summaries, keeping the request within budget.
 */
export async function generateReferatBody(
  transcript: TranscriptSegment[],
  spec: SkabelonSpec,
  participants?: string[],
  chapters?: TranscriptChapter[],
  customPrompt?: string,
): Promise<{ body: string }> {
  const transcriptText = renderTranscript(transcript);
  const instruction = buildSkabelonInstruction(spec, participants, customPrompt);
  const budget = transcriptBudgetChars();

  // Summarise per chapter when the transcript is long enough that condensing helps
  // the referat, OR when it simply will not fit the model's context window.
  const splitThreshold = Math.min(chapterSplitChars(), budget);

  if (chapters && chapters.length > 1 && transcriptText.length > splitThreshold) {
    const summaries = await Promise.all(
      chapters.map((ch) => {
        const chapterSegments = ch.segmentIndices.map((i) => transcript[i]).filter(Boolean);
        return _summarizeChapter(chapterSegments, ch.title);
      }),
    );
    const condensed = chapters.map((ch, i) => `## ${ch.title}\n${summaries[i]}`).join('\n\n');
    // Summaries are far smaller than the transcript, but a meeting with very many
    // chapters can still overflow — so the budget applies here too.
    const body = await _generateBody(truncateToBudget(condensed, budget), instruction);
    return { body };
  }

  // No chapters to split on (segmentation found one or none), or the transcript is
  // short enough to send whole. Either way it must still fit: without this, an
  // unchaptered long meeting went to the model in full and came back truncated.
  const body = await _generateBody(truncateToBudget(transcriptText, budget), instruction);
  return { body };
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

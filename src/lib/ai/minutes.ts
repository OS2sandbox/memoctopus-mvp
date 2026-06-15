import OpenAI from 'openai';
import { TranscriptSegment } from '@/types';
import { TranscriptChapter } from '@/lib/ai/chapters';

let client: OpenAI | null = null;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  return client;
}

const MINUTES_SYSTEM_PROMPT = `Du er en dansk mødesekretær der udarbejder professionelle mødereferater.

Du skriver:
- Klart og præcist dansk (ikke bureaukratisk, men formelt)
- I tredje person ("Mødet besluttede...", "Parterne aftalte...")
- Med fokus på beslutninger, handlinger og aftaler — ikke alt hvad der blev sagt
- Med respekt for mødets karakter og kontekst

Du skriver referatet som ét sammenhængende dokument i markdown.`;

// Transcript char length above which per-chapter summarisation is used (~30–60 min meeting)
const CHAPTER_SPLIT_THRESHOLD = 20_000;

// The generation-relevant subset of a Skabelon.
export interface SkabelonSpec {
  prompt: string;
  includeDeltagere: boolean;
  includeBeslutningspunkter: boolean;
  includeDagsorden: boolean;
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
    parts.push('Inkludér følgende afsnit i referatet:\n' + categories.join('\n'));
  } else if (participants && participants.length > 0) {
    parts.push(`Deltagere i mødet: ${participants.join(', ')}.`);
  }

  if (customPrompt && customPrompt.trim()) {
    parts.push('Yderligere instruktion til referatet: ' + customPrompt.trim());
  }
  return parts.join('\n\n');
}

// ─── Generation ───────────────────────────────────────────────────────────────

async function _generateBody(transcriptText: string, instruction: string): Promise<string> {
  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: MINUTES_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Udarbejd et mødereferat baseret på denne transskription.
${instruction ? `\n${instruction}\n` : ''}
Skriv referatet som ét sammenhængende dokument i markdown. Brug overskrifter (##) til afsnit og punktlister hvor det er relevant. Returner KUN selve referatet — ingen forklaringer, ingen JSON og ingen code blocks.

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
  const transcriptText = chapterSegments.map((s) => `[${s.speaker}]: ${s.text}`).join('\n');

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
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
  const transcriptText = transcript
    .map((s) => `[${s.speaker}] (${formatTime(s.start)}): ${s.text}`)
    .join('\n');
  const instruction = buildSkabelonInstruction(spec, participants, customPrompt);

  if (chapters && chapters.length > 1 && transcriptText.length > CHAPTER_SPLIT_THRESHOLD) {
    const summaries = await Promise.all(
      chapters.map((ch) => {
        const chapterSegments = ch.segmentIndices.map((i) => transcript[i]).filter(Boolean);
        return _summarizeChapter(chapterSegments, ch.title);
      }),
    );
    const condensed = chapters.map((ch, i) => `## ${ch.title}\n${summaries[i]}`).join('\n\n');
    const body = await _generateBody(condensed, instruction);
    return { body };
  }

  const body = await _generateBody(transcriptText, instruction);
  return { body };
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

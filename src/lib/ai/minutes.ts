import OpenAI from 'openai';
import { TranscriptSegment, TemplateSuggestion, MinutesContent, TemplateSectionDef } from '@/types';
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

Returner ALTID valid JSON uden markdown code blocks.`;

// Transcript char length above which per-chapter generation is used (~30–60 min meeting)
const CHAPTER_SPLIT_THRESHOLD = 20_000;

// ─── Per-chapter helpers ──────────────────────────────────────────────────────

async function _generateChapterChunk(
  chapterSegments: TranscriptSegment[],
  chapterTitle: string,
  templateSections: TemplateSectionDef[],
  customPrompt?: string,
): Promise<MinutesContent> {
  const transcriptText = chapterSegments
    .map((s) => `[${s.speaker}] (${formatTime(s.start)}): ${s.text}`)
    .join('\n');

  const sectionDescriptions = templateSections
    .map(
      (s) =>
        `- "${s.key}" (label: "${s.label}"${s.description ? `, beskrivelse: "${s.description}"` : ''}${s.required ? ', påkrævet' : ', valgfri'})`,
    )
    .join('\n');

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: MINUTES_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Udarbejd delreferat for mødekapitlet "${chapterTitle}".
${customPrompt ? `\nBrugerens instruktion: ${customPrompt}\n` : ''}
Sektioner:
${sectionDescriptions}

Transskription:
${transcriptText}

Returner JSON:
{
  "sections": [
    { "key": "sektionsnøgle", "label": "Sektionsoverskrift", "content": "Indhold som markdown" }
  ]
}

Medtag kun punkter relevante for dette kapitel. Brug tom streng for irrelevante sektioner.`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned) as MinutesContent;
  } catch {
    return { sections: templateSections.map((s) => ({ key: s.key, label: s.label, content: '' })) };
  }
}

function _mergeChunks(chunks: MinutesContent[], templateSections: TemplateSectionDef[]): MinutesContent {
  return {
    sections: templateSections.map((section) => {
      const parts = chunks
        .map((c) => c.sections.find((s) => s.key === section.key)?.content ?? '')
        .filter((c) => c.trim().length > 0);
      return { key: section.key, label: section.label, content: parts.join('\n\n') };
    }),
  };
}

async function _summarizeChapterForFreeform(
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

// ─── Public API ───────────────────────────────────────────────────────────────

export async function suggestTemplate(
  transcript: TranscriptSegment[],
  availableTemplates: Array<{ id: string; name: string; description: string }>,
): Promise<TemplateSuggestion> {
  const transcriptText = transcript.map((s) => `[${s.speaker}]: ${s.text}`).join('\n');
  const templateList = availableTemplates
    .map((t) => `- ${t.name} (id: ${t.id}): ${t.description}`)
    .join('\n');

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: MINUTES_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Baseret på denne transskription, hvilken skabelon passer bedst?

Tilgængelige skabeloner:
${templateList}

Transskription:
${transcriptText.slice(0, 3000)}

Returner JSON:
{
  "templateId": "id-på-valgt-skabelon eller null",
  "templateName": "Skabelonens navn",
  "explanation": "Kort forklaring på dansk (1-2 sætninger) om hvorfor denne skabelon passer"
}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';

  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned) as TemplateSuggestion;
  } catch {
    return {
      templateId: null,
      templateName: availableTemplates[0]?.name ?? 'Standard',
      explanation: 'Kunne ikke analysere transskriptionen automatisk.',
    };
  }
}

export async function deduplicateMinutesContent(content: MinutesContent): Promise<MinutesContent> {
  const hasContent = content.sections.some((s) => s.content.trim().length > 0);
  if (!hasContent) return content;

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: MINUTES_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Dette mødereferat er sammensat af kapitler og kan indeholde duplikerede eller gentagne punkter. Fjern dubletter og gentagelser på tværs af sektioner, men bevar al unik information.

${JSON.stringify(content)}

Returner JSON med samme struktur uden dubletter.`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned) as MinutesContent;
  } catch {
    return content;
  }
}

export async function generateMinutes(
  transcript: TranscriptSegment[],
  templateSections: TemplateSectionDef[],
  customPrompt?: string,
  participants?: string[],
  chapters?: TranscriptChapter[],
): Promise<MinutesContent> {
  const transcriptText = transcript
    .map((s) => `[${s.speaker}] (${formatTime(s.start)}): ${s.text}`)
    .join('\n');

  if (chapters && chapters.length > 1 && transcriptText.length > CHAPTER_SPLIT_THRESHOLD) {
    const chunks = await Promise.all(
      chapters.map((ch) => {
        const chapterSegments = ch.segmentIndices.map((i) => transcript[i]).filter(Boolean);
        return _generateChapterChunk(chapterSegments, ch.title, templateSections, customPrompt);
      }),
    );
    const merged = _mergeChunks(chunks, templateSections);
    const content = await deduplicateMinutesContent(merged);

    if (participants && participants.length > 0) {
      content.sections = content.sections.filter((s) => s.key !== 'deltagere');
      content.sections.unshift({
        key: 'deltagere',
        label: 'Deltagere',
        content: participants.map((p) => `- ${p}`).join('\n'),
      });
    }
    return content;
  }

  const sectionDescriptions = templateSections
    .map(
      (s) =>
        `- "${s.key}" (label: "${s.label}"${s.description ? `, beskrivelse: "${s.description}"` : ''}${s.required ? ', påkrævet' : ', valgfri'})`,
    )
    .join('\n');

  const participantLine = participants && participants.length > 0
    ? `\nDeltagere i mødet: ${participants.join(', ')}\n`
    : '';

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: MINUTES_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Udarbejd et mødereferat baseret på denne transskription.
${participantLine}${customPrompt ? `\nBrugerens instruktion til referatet: ${customPrompt}\n` : ''}
Referat skal have følgende sektioner:
${sectionDescriptions}

Transskription:
${transcriptText}

Returner JSON med denne struktur:
{
  "sections": [
    {
      "key": "sektionsnøgle",
      "label": "Sektionsoverskrift",
      "content": "Sektionens indhold som markdown-tekst"
    }
  ]
}

Skriv indholdet i sektionerne som klart, præcist dansk. Brug punktlister hvor det er relevant.`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';

  let content: MinutesContent;
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    content = JSON.parse(cleaned) as MinutesContent;
  } catch {
    content = {
      sections: templateSections.map((s) => ({ key: s.key, label: s.label, content: '' })),
    };
  }

  if (participants && participants.length > 0) {
    content.sections = content.sections.filter((s) => s.key !== 'deltagere');
    content.sections.unshift({
      key: 'deltagere',
      label: 'Deltagere',
      content: participants.map((p) => `- ${p}`).join('\n'),
    });
  }

  return content;
}

export async function generateMinutesFreeform(
  transcript: TranscriptSegment[],
  customPrompt: string,
  participants?: string[],
  chapters?: TranscriptChapter[],
): Promise<MinutesContent> {
  const transcriptText = transcript
    .map((s) => `[${s.speaker}] (${formatTime(s.start)}): ${s.text}`)
    .join('\n');

  if (chapters && chapters.length > 1 && transcriptText.length > CHAPTER_SPLIT_THRESHOLD) {
    const summaries = await Promise.all(
      chapters.map((ch) => {
        const chapterSegments = ch.segmentIndices.map((i) => transcript[i]).filter(Boolean);
        return _summarizeChapterForFreeform(chapterSegments, ch.title);
      }),
    );
    const condensed: TranscriptSegment[] = chapters.map((ch, i) => ({
      speaker: ch.title,
      start: ch.startTime,
      end: ch.endTime,
      text: summaries[i],
    }));
    // Call without chapters to avoid recursion
    return generateMinutesFreeform(condensed, customPrompt, participants);
  }

  const participantLine = participants && participants.length > 0
    ? `\nDeltagere i mødet: ${participants.join(', ')}\n`
    : '';

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: MINUTES_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Udarbejd et mødereferat baseret på denne transskription.
${participantLine}
Brugerens instruktion: ${customPrompt}

Beslut selv hvilke sektioner referatet skal have baseret på transskriptionen og brugerens instruktion. Brug 2–6 sektioner der passer til indholdet.

Transskription:
${transcriptText}

Returner JSON med denne struktur:
{
  "sections": [
    {
      "key": "sektionsnøgle",
      "label": "Sektionsoverskrift",
      "content": "Sektionens indhold som markdown-tekst"
    }
  ]
}

Skriv indholdet som klart, præcist dansk. Brug punktlister hvor det er relevant.`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';

  let content: MinutesContent;
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    content = JSON.parse(cleaned) as MinutesContent;
  } catch {
    content = { sections: [] };
  }

  if (participants && participants.length > 0) {
    content.sections = content.sections.filter((s) => s.key !== 'deltagere');
    content.sections.unshift({
      key: 'deltagere',
      label: 'Deltagere',
      content: participants.map((p) => `- ${p}`).join('\n'),
    });
  }

  return content;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

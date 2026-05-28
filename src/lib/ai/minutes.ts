import OpenAI from 'openai';
import { TranscriptSegment, TemplateSuggestion, MinutesContent, TemplateSectionDef } from '@/types';

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

export async function generateMinutes(
  transcript: TranscriptSegment[],
  templateSections: TemplateSectionDef[],
  customPrompt?: string,
): Promise<MinutesContent> {
  const transcriptText = transcript
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
        content: `Udarbejd et mødereferat baseret på denne transskription.
${customPrompt ? `\nBrugerens instruktion til referatet: ${customPrompt}\n` : ''}
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

  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned) as MinutesContent;
  } catch {
    return {
      sections: templateSections.map((s) => ({ key: s.key, label: s.label, content: '' })),
    };
  }
}

export async function generateMinutesFreeform(
  transcript: TranscriptSegment[],
  customPrompt: string,
): Promise<MinutesContent> {
  const transcriptText = transcript
    .map((s) => `[${s.speaker}] (${formatTime(s.start)}): ${s.text}`)
    .join('\n');

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: MINUTES_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Udarbejd et mødereferat baseret på denne transskription.

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

  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned) as MinutesContent;
  } catch {
    return { sections: [] };
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

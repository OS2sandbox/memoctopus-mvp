import Anthropic from '@anthropic-ai/sdk';
import { TranscriptSegment, TemplateSuggestion, MinutesContent, TemplateSectionDef } from '@/types';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

// ─── System prompt (cached) ──────────────────────────────────────────────────

const MINUTES_SYSTEM_PROMPT = `Du er en dansk mødesekretær der udarbejder professionelle mødereferater.

Du skriver:
- Klart og præcist dansk (ikke bureaukratisk, men formelt)
- I tredje person ("Mødet besluttede...", "Parterne aftalte...")
- Med fokus på beslutninger, handlinger og aftaler — ikke alt hvad der blev sagt
- Med respekt for mødets karakter og kontekst

Returner ALTID valid JSON uden markdown code blocks.`;

// ─── Template suggestion ─────────────────────────────────────────────────────

export async function suggestTemplate(
  transcript: TranscriptSegment[],
  availableTemplates: Array<{ id: string; name: string; description: string }>,
): Promise<TemplateSuggestion> {
  const transcriptText = transcript.map((s) => `[${s.speaker}]: ${s.text}`).join('\n');
  const templateList = availableTemplates
    .map((t) => `- ${t.name} (id: ${t.id}): ${t.description}`)
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: [
      {
        type: 'text',
        text: MINUTES_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
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

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response from Claude');
  }

  try {
    const raw = content.text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(raw) as TemplateSuggestion;
  } catch {
    return {
      templateId: null,
      templateName: availableTemplates[0]?.name ?? 'Standard',
      explanation: 'Kunne ikke analysere transskriptionen automatisk.',
    };
  }
}

// ─── Minutes generation ──────────────────────────────────────────────────────

export async function generateMinutes(
  transcript: TranscriptSegment[],
  templateSections: TemplateSectionDef[],
): Promise<MinutesContent> {
  const transcriptText = transcript.map((s) => `[${s.speaker}] (${formatTime(s.start)}): ${s.text}`).join('\n');

  const sectionDescriptions = templateSections
    .map(
      (s) =>
        `- "${s.key}" (label: "${s.label}"${s.description ? `, beskrivelse: "${s.description}"` : ''}${s.required ? ', påkrævet' : ', valgfri'})`,
    )
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: MINUTES_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Udarbejd et mødereferat baseret på denne transskription.

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

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response from Claude');
  }

  try {
    const raw = content.text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(raw) as MinutesContent;
  } catch {
    // Return empty sections matching the template
    return {
      sections: templateSections.map((s) => ({
        key: s.key,
        label: s.label,
        content: '',
      })),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

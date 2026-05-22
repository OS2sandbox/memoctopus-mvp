import Anthropic from '@anthropic-ai/sdk';
import { PiiResult, PiiReplacement } from '@/types';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const PII_SYSTEM_PROMPT = `Du er en dansk GDPR-assistent der identificerer og fjerner personhenførbare oplysninger (PII) fra mødetransskriptioner.

Du skal erstatte følgende typer oplysninger med placeholders:
- Personnavne → [NAVN]
- CPR-numre → [CPR]
- Adresser (gade, by, postnummer) → [ADRESSE]
- Telefonnumre → [TELEFON]
- E-mailadresser → [EMAIL]
- Andre identificerbare oplysninger → [ANDEN_PII]

Regler:
1. Bevar den naturlige sætningsstruktur og flow
2. Bevar organisationsnavne og stednavne MED MINDRE de bruges til at identificere en specifik person
3. Bevar datoer og tidspunkter
4. Bevar rollebetegnelser (f.eks. "direktøren", "formanden") med mindre de direkte identificerer en person
5. Returner ALTID valid JSON

Returner JSON i dette format:
{
  "cleanedText": "Den rensede tekst",
  "replacements": [
    {
      "original": "den originale tekst",
      "replacement": "placeholderen",
      "type": "NAVN"
    }
  ]
}`;

export async function removePii(text: string): Promise<PiiResult> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8096,
    system: PII_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Identificer og fjern al PII fra følgende transskription. Returner kun JSON uden markdown code blocks:\n\n${text}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  try {
    // Strip markdown code fences if present
    const raw = content.text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(raw) as {
      cleanedText: string;
      replacements: Array<{
        original: string;
        replacement: string;
        type: string;
      }>;
    };

    const replacements: PiiReplacement[] = parsed.replacements.map((r) => ({
      original: r.original,
      replacement: r.replacement,
      type: r.type as PiiReplacement['type'],
    }));

    return {
      cleanedText: parsed.cleanedText,
      replacements,
    };
  } catch {
    // If parsing fails, return the raw text as-is with no replacements
    console.error('Failed to parse PII response, returning original text');
    return {
      cleanedText: text,
      replacements: [],
    };
  }
}

export async function removePiiFromSegments(
  segments: Array<{ speaker: string; start: number; end: number; text: string }>,
): Promise<{
  cleanedSegments: typeof segments;
  replacements: PiiReplacement[];
}> {
  const fullText = segments.map((s) => `[${s.speaker}]: ${s.text}`).join('\n');
  const result = await removePii(fullText);

  // Re-parse the cleaned segments
  const cleanedLines = result.cleanedText.split('\n');
  const cleanedSegments = segments.map((seg, i) => {
    const line = cleanedLines[i];
    if (!line) return seg;
    const match = line.match(/^\[[^\]]+\]:\s(.+)$/);
    return {
      ...seg,
      text: match ? match[1] : seg.text,
    };
  });

  return { cleanedSegments, replacements: result.replacements };
}

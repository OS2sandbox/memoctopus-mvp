import { Mistral } from '@mistralai/mistralai';
import { PiiResult, PiiReplacement } from '@/types';

let client: Mistral | null = null;
function getClient() {
  if (!client) client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });
  return client;
}

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
  const response = await getClient().chat.complete({
    model: 'mistral-large-latest',
    messages: [
      { role: 'system', content: PII_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Identificer og fjern al PII fra følgende transskription. Returner kun JSON uden markdown code blocks:\n\n${text}`,
      },
    ],
  });

  const raw = (response.choices?.[0]?.message?.content as string) ?? '';

  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as {
      cleanedText: string;
      replacements: Array<{ original: string; replacement: string; type: string }>;
    };

    const replacements: PiiReplacement[] = parsed.replacements.map((r) => ({
      original: r.original,
      replacement: r.replacement,
      type: r.type as PiiReplacement['type'],
    }));

    return { cleanedText: parsed.cleanedText, replacements };
  } catch {
    console.error('Failed to parse PII response, returning original text');
    return { cleanedText: text, replacements: [] };
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

  const cleanedLines = result.cleanedText.split('\n');
  const cleanedSegments = segments.map((seg, i) => {
    const line = cleanedLines[i];
    if (!line) return seg;
    const match = line.match(/^\[[^\]]+\]:\s(.+)$/);
    return { ...seg, text: match ? match[1] : seg.text };
  });

  return { cleanedSegments, replacements: result.replacements };
}

export async function detectPiiInSegments(
  segments: Array<{ speaker: string; start: number; end: number; text: string }>,
): Promise<{ replacements: PiiReplacement[] }> {
  const fullText = segments.map((s) => `[${s.speaker}]: ${s.text}`).join('\n');
  const result = await removePii(fullText);

  const replacements: PiiReplacement[] = result.replacements.map((r) => {
    const idx = segments.findIndex((seg) => seg.text.includes(r.original));
    return { ...r, segmentIndex: idx >= 0 ? idx : undefined };
  });

  return { replacements };
}

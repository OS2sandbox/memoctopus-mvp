import OpenAI from 'openai';
import { PiiResult, PiiReplacement } from '@/types';

let client: OpenAI | null = null;
function getClient() {
  if (!client) client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'no-key',
    baseURL: process.env.LLM_BASE_URL || 'http://vllm-chat:8000/v1',
  });
  return client;
}
const LLM_MODEL = process.env.LLM_MODEL || 'Qwen/Qwen3.6-27B';

const PII_SYSTEM_PROMPT = `Du er en dansk GDPR-assistent der identificerer og fjerner personhenførbare oplysninger fra mødetransskriptioner, baseret på EU-forordning 2016/679.

Erstat kun oplysninger der direkte identificerer en privat person:
- Fulde personnavne på private individer → [NAVN]
- CPR-numre → [CPR]
- Private kontaktoplysninger (hjemmeadresse, privat telefon, privat e-mail) → [KONTAKT]

Erstat særlige kategorier (artikel 9) — helbredsoplysninger, racemæssig/etnisk oprindelse, politiske meninger, religiøse/filosofiske overbevisninger, fagforeningsmedlemskab, genetiske data, biometriske identifikatorer, seksuel orientering → [FØLSOM]

Bevar altid:
- Organisationsnavne, virksomhedsnavne og institutioner
- Stillingsbetegnelser og professionelle roller (f.eks. "direktøren", "formanden", "sagsbehandleren")
- Stednavne, byer og geografiske referencer
- Datoer og tidspunkter
- Taler-etiketter i formatet [Navn]: i starten af linjer — disse er tekniske identifikatorer, ikke PII
- Navne brugt i professionel/institutionel sammenhæng

Returner ALTID valid JSON i dette format:
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
  const response = await getClient().chat.completions.create({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: PII_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Identificer og fjern al PII fra følgende transskription. Returner kun JSON uden markdown code blocks:\n\n${text}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';

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

import { PiiResult, PiiReplacement } from '@/types';
import { getLlmClient, llmModel } from './llm-client';

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
  const response = await getLlmClient().chat.completions.create({
    model: llmModel('gpt-4o'),
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
  } catch (err) {
    // Log the raw LLM response alongside the error so parse failures are traceable.
    // NOTE: returning the original text is intentional (GDPR-safe fallback), but a
    // piiDetectionFailed flag to let callers distinguish "no PII" from "parse error"
    // would require extending PiiResult in src/types/index.ts — see notes.
    console.error('[pii] parse failed. raw:', raw, err);
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

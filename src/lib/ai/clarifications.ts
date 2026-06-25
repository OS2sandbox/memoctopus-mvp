import OpenAI from 'openai';

let client: OpenAI | null = null;
function getClient() {
  if (!client) client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'no-key',
    baseURL: process.env.LLM_BASE_URL || 'http://vllm-chat:8000/v1',
  });
  return client;
}
const LLM_MODEL = process.env.LLM_MODEL || 'Qwen/Qwen3.6-27B';

export interface ClarificationItem {
  /** A concrete clarifying question, in Danish. */
  question: string;
  /** Short label for what the question relates to (optional). */
  context?: string;
}

// Surfaces things that ought to be clarified while a meeting is still in progress:
// open questions left unanswered, ambiguous statements, undefined terms, and
// decisions/action items missing an owner, deadline, or scope.
export async function analyzeClarifications(transcript: string): Promise<ClarificationItem[]> {
  const response = await getClient().chat.completions.create({
    model: LLM_MODEL,
    messages: [
      {
        role: 'user',
        content: `Du hjælper en mødedeltager med at fange ting der bør afklares, mens mødet er i gang.

Læs uddraget af mødetransskriptionen og find de punkter der er uafklarede, tvetydige eller mangler detaljer — fx beslutninger uden ansvarlig eller deadline, åbne spørgsmål der ikke blev besvaret, vage formuleringer eller begreber der ikke er defineret.

Transskription:
${transcript.slice(-3000)}

Returner JSON uden markdown:
{
  "clarifications": [
    {
      "question": "Et konkret afklarende spørgsmål på dansk (maks 14 ord)",
      "context": "Kort hvad det handler om (maks 6 ord)"
    }
  ]
}

Maks 4 spørgsmål, kun de vigtigste. Hvis intet er uafklaret, returnér {"clarifications": []}.`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return (JSON.parse(cleaned) as { clarifications: ClarificationItem[] }).clarifications ?? [];
  } catch {
    return [];
  }
}

import OpenAI from 'openai';

let client: OpenAI | null = null;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  return client;
}

export interface TopicItem {
  topic: string;
  followUps: string[];
}

export async function analyzeTopics(transcript: string): Promise<TopicItem[]> {
  const response = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: `Analyser denne mødetransskription og identificer de aktuelle emner der diskuteres.

Transskription:
${transcript.slice(-3000)}

Returner JSON uden markdown:
{
  "topics": [
    {
      "topic": "Emnetitel på dansk (maks 6 ord)",
      "followUps": ["Opfølgningsspørgsmål 1", "Opfølgningsspørgsmål 2"]
    }
  ]
}

Maks 4 emner. Maks 2 opfølgningsspørgsmål per emne. Vær konkret og kortfattet.`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return (JSON.parse(cleaned) as { topics: TopicItem[] }).topics ?? [];
  } catch {
    return [];
  }
}

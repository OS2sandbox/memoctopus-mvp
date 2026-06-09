import OpenAI from 'openai';
import { TranscriptSegment } from '@/types';

let client: OpenAI | null = null;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  return client;
}

export interface TranscriptChapter {
  id: string;
  title: string;
  summary: string;
  startTime: number;
  endTime: number;
  segmentIndices: number[];
}

export async function groupIntoChapters(segments: TranscriptSegment[]): Promise<TranscriptChapter[]> {
  if (segments.length === 0) return [];

  const totalDuration = segments[segments.length - 1]?.end ?? 0;
  const mins = totalDuration / 60;
  const range =
    mins < 5  ? '1' :
    mins < 15 ? '1–2' :
    mins < 30 ? '2–4' :
                '3–6';

  const MAX_SEGMENT_CHARS = 200;
  const transcriptText = segments
    .map((s, i) => {
      const text = s.text.length > MAX_SEGMENT_CHARS
        ? s.text.slice(0, MAX_SEGMENT_CHARS) + '…'
        : s.text;
      return `[${i}] ${fmt(s.start)} [${s.speaker}]: ${text}`;
    })
    .join('\n');

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: `Analyser denne mødetransskription og opdel den i tematiske kapitler baseret på emneskift.

Hvert segment er markeret med sit indeks [0], [1] osv. og tidsstempel.
Mødelængde: ca. ${Math.round(mins)} minutter → brug ${range} kapitel${range === '1' ? '' : 'er'}.

Transskription:
${transcriptText}

Returner JSON uden markdown:
{
  "chapters": [
    {
      "title": "Kapiteloverskrift på dansk (maks 8 ord)",
      "summary": "Kort resumé af hvad der diskuteres (1-2 sætninger på dansk)",
      "segmentIndices": [0, 1, 2]
    }
  ]
}

Regler:
- Alle segmentindekser 0–${segments.length - 1} skal dækkes af præcis ét kapitel
- Kapitelindekser skal være sammenhængende og stigende
- Antal kapitler: ${range}
- Titler og resuméer på dansk`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';
  try {
    // Extract the JSON object even if the model wraps it in prose or markdown fences
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in response');
    const parsed = JSON.parse(jsonMatch[0]) as {
      chapters: Array<{ title: string; summary: string; segmentIndices: number[] }>;
    };

    const chapters = parsed.chapters.map((ch, i) => ({
      id: `ch-${i}`,
      title: ch.title,
      summary: ch.summary,
      startTime: segments[ch.segmentIndices[0]]?.start ?? 0,
      endTime: segments[ch.segmentIndices[ch.segmentIndices.length - 1]]?.end ?? 0,
      segmentIndices: ch.segmentIndices,
    }));

    // Clamp each chapter's endTime to the next chapter's startTime to prevent overlap
    for (let i = 0; i < chapters.length - 1; i++) {
      chapters[i].endTime = Math.min(chapters[i].endTime, chapters[i + 1].startTime);
    }

    return chapters;
  } catch {
    return [
      {
        id: 'ch-0',
        title: 'Transskription',
        summary: 'Hele mødetransskriptionen.',
        startTime: segments[0]?.start ?? 0,
        endTime: segments[segments.length - 1]?.end ?? 0,
        segmentIndices: segments.map((_, i) => i),
      },
    ];
  }
}

function fmt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

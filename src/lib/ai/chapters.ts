import { Mistral } from '@mistralai/mistralai';
import { TranscriptSegment } from '@/types';

let client: Mistral | null = null;
function getClient() {
  if (!client) client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });
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

  const transcriptText = segments
    .map((s, i) => `[${i}] ${fmt(s.start)} [${s.speaker}]: ${s.text}`)
    .join('\n');

  const response = await getClient().chat.complete({
    model: 'mistral-large-latest',
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

  const raw = (response.choices?.[0]?.message?.content as string) ?? '';
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as {
      chapters: Array<{ title: string; summary: string; segmentIndices: number[] }>;
    };

    return parsed.chapters.map((ch, i) => ({
      id: `ch-${i}`,
      title: ch.title,
      summary: ch.summary,
      startTime: segments[ch.segmentIndices[0]]?.start ?? 0,
      endTime: segments[ch.segmentIndices[ch.segmentIndices.length - 1]]?.end ?? 0,
      segmentIndices: ch.segmentIndices,
    }));
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

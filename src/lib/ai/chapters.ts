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
    mins < 60 ? '3–6' :
    mins < 90 ? '5–9' :
                '7–14';

  const transcriptText = segments
    .map((s, i) => `[${i}] ${fmt(s.start)} [${s.speaker}]: ${s.text}`)
    .join('\n');

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: `Analyser denne mødetransskription og identificer emneskift.

Hvert segment er markeret med sit indeks [0], [1] osv. og tidsstempel.
Mødelængde: ca. ${Math.round(mins)} minutter → brug ${range} kapitel${range === '1' ? '' : 'er'}.

Transskription:
${transcriptText}

Returner JSON uden markdown:
{
  "chapters": [
    {
      "startIndex": 0,
      "title": "Kapiteloverskrift på dansk (maks 8 ord)",
      "summary": "Kort resumé af hvad der diskuteres (1-2 sætninger på dansk)"
    }
  ]
}

Regler:
- Første kapitel starter ALTID ved startIndex 0
- startIndex skal være stigende for hvert kapitel
- Det sidste kapitel dækker automatisk resten af transskriptionen til og med segment ${segments.length - 1}
- Antal kapitler: ${range}
- Titler og resuméer på dansk
- Opdel efter emne, ikke kronologi`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in response');
    const parsed = JSON.parse(jsonMatch[0]) as {
      chapters: Array<{ startIndex: number; title: string; summary: string }>;
    };

    if (!Array.isArray(parsed.chapters) || parsed.chapters.length === 0) throw new Error('Empty chapters');

    // Sort by startIndex and clamp to valid range
    const sorted = [...parsed.chapters]
      .sort((a, b) => a.startIndex - b.startIndex)
      .map((ch) => ({ ...ch, startIndex: Math.max(0, Math.min(ch.startIndex, segments.length - 1)) }));

    // Force first chapter to start at 0
    sorted[0].startIndex = 0;

    // Build contiguous ranges from boundary indices
    const chapters: TranscriptChapter[] = sorted.map((ch, i) => {
      const startIdx = ch.startIndex;
      const endIdx = (sorted[i + 1]?.startIndex ?? segments.length) - 1;
      const segmentIndices = Array.from({ length: endIdx - startIdx + 1 }, (_, j) => startIdx + j);
      return {
        id: `ch-${i}`,
        title: ch.title,
        summary: ch.summary,
        startTime: segments[startIdx]?.start ?? 0,
        endTime: segments[endIdx]?.end ?? 0,
        segmentIndices,
      };
    });

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

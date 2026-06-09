import { NextRequest, NextResponse } from 'next/server';
import { groupIntoChapters } from '@/lib/ai/chapters';
import { TranscriptSegment } from '@/types';

// POST: generate chapters via AI and return them (no DB write — client stores in IndexedDB)
export async function POST(req: NextRequest) {
  const { segments } = (await req.json()) as { segments?: TranscriptSegment[] };
  if (!segments?.length) return NextResponse.json({ chapters: [] });

  try {
    const chapters = await groupIntoChapters(segments);
    return NextResponse.json({ chapters });
  } catch {
    return NextResponse.json({ chapters: [] });
  }
}

// PATCH: client-side only; stub for backwards compat
export async function PATCH() {
  return NextResponse.json({ ok: true });
}

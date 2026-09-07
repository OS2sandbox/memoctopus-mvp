import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { groupIntoChapters } from '@/lib/ai/chapters';
import { TranscriptSegment } from '@/types';

// POST: generate chapters via AI and return them (no DB write — client stores in IndexedDB)
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { segments } = (await req.json()) as { segments?: TranscriptSegment[] };
  if (!segments?.length) return NextResponse.json({ chapters: [] });

  try {
    const chapters = await groupIntoChapters(segments);
    return NextResponse.json({ chapters });
  } catch (err) {
    console.error('[chapters route] groupIntoChapters failed, returning empty fallback:', err);
    return NextResponse.json({ chapters: [] });
  }
}

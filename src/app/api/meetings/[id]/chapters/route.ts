import { NextRequest, NextResponse } from 'next/server';
import { groupIntoChapters } from '@/lib/ai/chapters';
import { TranscriptSegment } from '@/types';
import { withHandler } from '@/lib/api-handler';
import { safeLogError } from '@/lib/audit/safe-log';
import { requireAppAccess } from '@/lib/authz/app-access';

interface Params {
  params: Promise<{ id: string }>;
}

// POST: generate chapters via AI and return them (no DB write — client stores in IndexedDB)
async function postHandler(req: NextRequest, _ctx: Params) {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;

  const { segments } = (await req.json()) as { segments?: TranscriptSegment[] };
  if (!segments?.length) return NextResponse.json({ chapters: [] });

  try {
    const chapters = await groupIntoChapters(segments);
    return NextResponse.json({ chapters });
  } catch (err) {
    // Fails soft (empty result); the log line carries error name/status/code only.
    safeLogError('chapters route', err);
    return NextResponse.json({ chapters: [] });
  }
}

export const POST = withHandler('chapters', postHandler);

import { NextRequest, NextResponse } from 'next/server';
import { groupIntoChapters } from '@/lib/ai/chapters';
import { TranscriptSegment } from '@/types';
import { withHandler } from '@/lib/api-handler';
import { safeLogError } from '@/lib/audit/safe-log';
import { asEntityUuid, elapsedMs, emitAudit, outcomeCodeOf } from '@/app/api/meetings/ai-audit';
import { requireAppAccess } from '@/lib/authz/app-access';

interface Params {
  params: Promise<{ id: string }>;
}

// POST: generate chapters via AI and return them (no DB write — client stores in IndexedDB)
async function postHandler(req: NextRequest, ctx: Params) {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const { segments } = (await req.json()) as { segments?: TranscriptSegment[] };
  if (!segments?.length) return NextResponse.json({ chapters: [] });

  // The id in the URL is never verified against a meeting: UUID or no entity.
  const entityId = asEntityUuid((await ctx.params).id);
  const t0 = Date.now();
  try {
    const chapters = await groupIntoChapters(segments);
    await emitAudit(req, {
      type: 'chapters.request',
      actorUserId: session.user.id,
      entityId,
      details: { segmentCount: segments.length, chapterCount: chapters.length, durationMs: elapsedMs(t0) },
    });
    return NextResponse.json({ chapters });
  } catch (err) {
    // Fails soft (empty result); the log line carries error name/status/code only.
    safeLogError('chapters route', err);
    await emitAudit(req, {
      type: 'chapters.request',
      actorUserId: session.user.id,
      outcome: 'error',
      entityId,
      details: { segmentCount: segments.length, durationMs: elapsedMs(t0), outcomeCode: outcomeCodeOf(err) },
    });
    return NextResponse.json({ chapters: [] });
  }
}

export const POST = withHandler('chapters', postHandler);

import { NextRequest, NextResponse } from 'next/server';
import { analyzeClarifications } from '@/lib/ai/clarifications';
import { withHandler } from '@/lib/api-handler';
import { safeLogError } from '@/lib/audit/safe-log';
import { asEntityUuid, elapsedMs, emitAudit, outcomeCodeOf } from '@/app/api/meetings/ai-audit';
import { clarificationCoalescer, clarificationKey } from './coalesce';
import { requireAppAccess } from '@/lib/authz/app-access';

interface Params {
  params: Promise<{ id: string }>;
}

// Live, non-persisted analysis: given the transcript so far, return a short list
// of things worth clarifying. Called periodically by the recording screen.
async function postHandler(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const { transcript } = await req.json() as { transcript?: string };
  if (!transcript?.trim()) return NextResponse.json({ clarifications: [] });

  // The id in the URL is never verified against a meeting: UUID or no entity.
  const entityId = asEntityUuid(id);
  const t0 = Date.now();
  try {
    const clarifications = await analyzeClarifications(transcript);
    if (clarificationCoalescer.shouldEmit(clarificationKey(session.user.id, id, 'success'))) {
      await emitAudit(req, {
        type: 'clarifications.request',
        actorUserId: session.user.id,
        entityId,
        details: { questionCount: clarifications.length, durationMs: elapsedMs(t0) },
      });
    }
    return NextResponse.json({ clarifications });
  } catch (err) {
    // Fails soft (empty result); the log line carries error name/status/code only.
    safeLogError('clarifications route', err);
    if (clarificationCoalescer.shouldEmit(clarificationKey(session.user.id, id, 'error'))) {
      await emitAudit(req, {
        type: 'clarifications.request',
        actorUserId: session.user.id,
        outcome: 'error',
        entityId,
        details: { durationMs: elapsedMs(t0), outcomeCode: outcomeCodeOf(err) },
      });
    }
    return NextResponse.json({ clarifications: [] });
  }
}

export const POST = withHandler('clarifications', postHandler);

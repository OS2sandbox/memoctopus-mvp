import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { markStepSeen, skipTour, completeTour } from '@/lib/onboarding/store';
import { withHandler } from '@/lib/api-handler';

async function postHandler(req: NextRequest): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = body.action as 'seen' | 'skip-tour' | 'complete-tour' | undefined;

  if (action === 'skip-tour') {
    await skipTour(session.user.id);
    return NextResponse.json({ ok: true });
  }
  if (action === 'complete-tour') {
    await completeTour(session.user.id);
    return NextResponse.json({ ok: true });
  }

  const stepId = typeof body.stepId === 'string' ? body.stepId : '';
  if (!stepId) return NextResponse.json({ error: 'stepId er påkrævet' }, { status: 400 });
  const meetingId = typeof body.meetingId === 'string' ? body.meetingId : null;

  await markStepSeen(session.user.id, stepId, meetingId);
  return NextResponse.json({ ok: true });
}

export const POST = withHandler('onboarding/step', postHandler);

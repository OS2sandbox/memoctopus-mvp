import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { markStepSeen, skipTour, completeTour, resetHints } from '@/lib/onboarding/store';
import { withHandler } from '@/lib/api-handler';
import { ONBOARDING_STEPS } from '@/lib/onboarding/steps';

// A meeting id is a UUID generated in the browser; the cap only stops absurd values.
const MAX_MEETING_ID_LENGTH = 100;

async function postHandler(req: NextRequest): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = await req.json().catch(() => null);
  // `null`, arrays and primitives are valid JSON but not something we can read fields from.
  const body: Record<string, unknown> =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const action = body.action as 'seen' | 'skip-tour' | 'complete-tour' | 'reset-hints' | undefined;

  if (action === 'skip-tour') {
    await skipTour(session.user.id);
    return NextResponse.json({ ok: true });
  }
  if (action === 'reset-hints') {
    await resetHints(session.user.id);
    return NextResponse.json({ ok: true });
  }
  if (action === 'complete-tour') {
    await completeTour(session.user.id);
    return NextResponse.json({ ok: true });
  }

  const stepId = typeof body.stepId === 'string' ? body.stepId : '';
  if (!stepId) return NextResponse.json({ error: 'stepId er påkrævet' }, { status: 400 });
  // Only steps that exist in the registry are stored (own keys only: 'constructor' is not a step).
  if (!Object.prototype.hasOwnProperty.call(ONBOARDING_STEPS, stepId)) {
    return NextResponse.json({ error: 'Ukendt stepId' }, { status: 400 });
  }

  const rawMeetingId = body.meetingId;
  if (rawMeetingId != null) {
    if (typeof rawMeetingId !== 'string' || rawMeetingId.length === 0 || rawMeetingId.length > MAX_MEETING_ID_LENGTH) {
      return NextResponse.json({ error: 'Ugyldigt meetingId' }, { status: 400 });
    }
  }
  const meetingId = typeof rawMeetingId === 'string' ? rawMeetingId : null;

  await markStepSeen(session.user.id, stepId, meetingId);
  return NextResponse.json({ ok: true });
}

export const POST = withHandler('onboarding/step', postHandler);

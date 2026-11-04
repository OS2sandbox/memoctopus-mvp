import { NextResponse } from 'next/server';
import { requireAppAccess } from '@/lib/authz/app-access';
import { getOnboardingState, getSeenSteps } from '@/lib/onboarding/store';
import { withHandler } from '@/lib/api-handler';

async function getHandler(): Promise<NextResponse> {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const [state, seen] = await Promise.all([
    getOnboardingState(session.user.id),
    getSeenSteps(session.user.id),
  ]);

  return NextResponse.json({ ...state, seen });
}

export const GET = withHandler('onboarding/state', getHandler);

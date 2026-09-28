import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getOnboardingState, getSeenSteps } from '@/lib/onboarding/store';
import { withHandler } from '@/lib/api-handler';

async function getHandler(): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [state, seen] = await Promise.all([
    getOnboardingState(session.user.id),
    getSeenSteps(session.user.id),
  ]);

  return NextResponse.json({ ...state, seen });
}

export const GET = withHandler('onboarding/state', getHandler);

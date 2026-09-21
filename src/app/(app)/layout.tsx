import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { TopBar } from '@/components/layout/TopBar';
import { ReviewAudioProvider } from '@/lib/review-audio-context';
import { StorageScope } from '@/components/providers/StorageScope';
import { auth } from '@/lib/auth';
import { SESSION_EXPIRED_PARAM } from '@/middleware';
import { OnboardingProvider, type OnboardingInitialState } from '@/lib/onboarding/context';
import { WelcomeTour } from '@/components/onboarding/WelcomeTour';
import { getOnboardingState, getSeenSteps } from '@/lib/onboarding/store';

// Onboarding is a nicety on top of pages that are otherwise IndexedDB-based, so a database
// hiccup here (or a failed migration of its tables) must not turn every page, including the
// recording screen, into a 500. Fall back to "show nothing".
async function loadOnboarding(userId: string): Promise<OnboardingInitialState> {
  try {
    const [state, seen] = await Promise.all([getOnboardingState(userId), getSeenSteps(userId)]);
    return { ...state, seen };
  } catch (err) {
    console.error('[onboarding] could not load state; continuing without onboarding', err);
    return { tourSkipped: false, tourCompleted: false, seen: [], unavailable: true };
  }
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Authoritative auth gate for EVERY route under (app). The middleware only
  // checks that a session cookie is present (a fast UX redirect, not a security
  // boundary), so a forged or expired cookie would otherwise render these pages.
  // Validating the actual token server-side here — before any authenticated UI
  // is sent — closes that bypass and cannot be defeated from the client.
  const session = await auth.api.getSession({ headers: await headers() });
  // The marker tells the middleware not to bounce this request straight back
  // here on the strength of the same cookie we just rejected — see
  // SESSION_EXPIRED_PARAM.
  if (!session) redirect(`/?${SESSION_EXPIRED_PARAM}=1`);

  const onboarding = await loadOnboarding(session.user.id);

  // Bind client-side storage to this user so a different user on the same browser
  // never reads their meetings from the shared origin database.
  return (
    <StorageScope userId={session.user.id}>
      <ReviewAudioProvider>
        <OnboardingProvider initial={onboarding}>
          <div className="min-h-screen bg-[var(--bg)]">
            <TopBar />
            <main>{children}</main>
            <WelcomeTour />
          </div>
        </OnboardingProvider>
      </ReviewAudioProvider>
    </StorageScope>
  );
}

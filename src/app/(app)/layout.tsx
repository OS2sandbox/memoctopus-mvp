import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { TopBar } from '@/components/layout/TopBar';
import { ReviewAudioProvider } from '@/lib/review-audio-context';
import { StorageScope } from '@/components/providers/StorageScope';
import { auth } from '@/lib/auth';
import { OnboardingProvider } from '@/lib/onboarding/context';
import { WelcomeTour } from '@/components/onboarding/WelcomeTour';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Authoritative auth gate for EVERY route under (app). The middleware only
  // checks that a session cookie is present (a fast UX redirect, not a security
  // boundary), so a forged or expired cookie would otherwise render these pages.
  // Validating the actual token server-side here — before any authenticated UI
  // is sent — closes that bypass and cannot be defeated from the client.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/');

  // Bind client-side storage to this user so a different user on the same browser
  // never reads their meetings from the shared origin database.
  //
  // OnboardingProvider fetches its own state client-side (GET /api/onboarding/state)
  // rather than this server component awaiting the same DB round trip on every
  // authenticated page load, including the recording screen, for a feature that is
  // purely a client-interactive nicety.
  return (
    <StorageScope userId={session.user.id}>
      <ReviewAudioProvider>
        <OnboardingProvider>
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

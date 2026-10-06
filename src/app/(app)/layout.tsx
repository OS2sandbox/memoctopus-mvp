import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { TopBar } from '@/components/layout/TopBar';
import { ReviewAudioProvider } from '@/lib/review-audio-context';
import { StorageScope } from '@/components/providers/StorageScope';
import { NoAccess } from '@/components/layout/NoAccess';
import { AccessUnavailable } from '@/components/layout/AccessUnavailable';
import { safeLogError } from '@/lib/audit/safe-log';
import type { Principal } from '@/lib/authz/types';
import { auth } from '@/lib/auth';
import { loginRefusal } from '@/lib/authz/guard';
import { recordAuthzDenied } from '@/lib/audit/authz-denied';
import { resolvePrincipal } from '@/lib/authz/principal';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Authoritative auth gate for EVERY route under (app). The middleware only
  // checks that a session cookie is present (a fast UX redirect, not a security
  // boundary), so a forged or expired cookie would otherwise render these pages.
  // Validating the actual token server-side here — before any authenticated UI
  // is sent — closes that bypass and cannot be defeated from the client.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/');

  // Disabled directory users and (with REQUIRE_ROLE_TO_LOGIN=true) users without
  // a role get no app shell. The /api routes apply the same refusal through
  // requireAppAccess, so a client navigation cannot get around this gate.
  // Fail closed: if the principal cannot be resolved, render a retry screen
  // instead of the app shell (and instead of the global error page).
  let principal: Principal;
  try {
    principal = await resolvePrincipal(session.user.id);
  } catch (err) {
    safeLogError('app-layout principal', err);
    return <AccessUnavailable />;
  }
  const refusal = loginRefusal(principal);
  if (refusal) {
    recordAuthzDenied({ actorUserId: principal.userId, required: 'login', reason: refusal });
    return <NoAccess reason={refusal} />;
  }

  // Bind client-side storage to this user so a different user on the same browser
  // never reads their meetings from the shared origin database.
  return (
    <StorageScope userId={session.user.id}>
      <ReviewAudioProvider>
        <div className="min-h-screen bg-[var(--bg)]">
          <TopBar />
          <main>{children}</main>
        </div>
      </ReviewAudioProvider>
    </StorageScope>
  );
}

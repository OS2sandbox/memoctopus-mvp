import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { teamsGraphEnabled } from '@/lib/auth/providers';
import { GraphError, hasGraphScopes } from '@/lib/teams/graph-client';

/**
 * Whether this user can use the Teams features at all. Drives the dashboard:
 * email/password and generic-OIDC users have no Microsoft account
 * (`microsoftLinked: false`), and Microsoft users who signed in before the
 * Graph scopes were added get `scopesOk: false` plus the missing scopes.
 *
 * `enabled: false` means TEAMS_GRAPH_ENABLED is off: the Graph scopes are not
 * requested at sign-in, so "missing scopes" would be meaningless and the UI must
 * not ask anyone to sign in again. Answered before any token is looked at.
 */
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!teamsGraphEnabled()) {
    return NextResponse.json({ enabled: false, microsoftLinked: false, scopesOk: false, missing: [] });
  }

  try {
    const { ok, missing } = await hasGraphScopes(session.user.id);
    return NextResponse.json({ enabled: true, microsoftLinked: true, scopesOk: ok, missing });
  } catch (err) {
    // No linked Microsoft account (or a dead refresh token) surfaces as
    // reauth_required — for this endpoint that is an answer, not an error.
    if (err instanceof GraphError && err.code === 'reauth_required') {
      return NextResponse.json({ enabled: true, microsoftLinked: false, scopesOk: false, missing: [] });
    }
    console.error('[teams/status] scope check failed:', err);
    return NextResponse.json({ enabled: true, microsoftLinked: false, scopesOk: false, missing: [] });
  }
}

import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { recordAuthzDenied } from '@/lib/audit/authz-denied';
import { safeLogError } from '@/lib/audit/safe-log';
import { loginRefusal, type AuthSession } from './guard';
import { resolvePrincipal } from './principal';
import type { Principal } from './types';

export interface AppAccess {
  session: AuthSession;
  principal: Principal;
}

/**
 * Shared access gate for the older /api routes that have no capability of their
 * own (minutes, transcribe, export, meetings/*, bot/*, skabeloner/*). It applies
 * the same refusal as the (app) layout: a disabled directory user, or (with
 * REQUIRE_ROLE_TO_LOGIN=true) a user without a role, is refused on every call,
 * not only when a page renders.
 *
 *   const access = await requireAppAccess();
 *   if (access instanceof NextResponse) return access;
 *   const { session } = access;
 *
 * Order: no session -> 401; principal lookup fails -> 503 (fail closed, never
 * "allowed"); refused principal -> 403 (+ denial event); otherwise the session
 * and live principal. Call it before reading the body, so a refused caller
 * learns nothing about the request. Roles are resolved live on every call (no
 * cache): this is 2 queries per request, utterance included.
 */
export async function requireAppAccess(): Promise<AppAccess | NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let principal: Principal;
  try {
    principal = await resolvePrincipal(session.user.id);
  } catch (err) {
    safeLogError('app-access principal', err);
    return NextResponse.json({ error: 'Adgangskontrol er midlertidigt utilgængelig' }, { status: 503 });
  }

  const refusal = loginRefusal(principal);
  if (refusal) {
    recordAuthzDenied({ actorUserId: principal.userId, required: 'login', reason: refusal });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return { session, principal };
}

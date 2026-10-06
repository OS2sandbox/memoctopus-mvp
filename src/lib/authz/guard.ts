import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { withHandler } from '@/lib/api-handler';
import { recordAuthzDenied } from '@/lib/audit/authz-denied';
import { accessSource, requireRoleToLogin } from './config';
import { hasCapability } from './permissions';
import { resolvePrincipal } from './principal';
import type { Capability, Principal } from './types';

export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

export interface AuthzContext<P = Record<string, never>> {
  session: AuthSession;
  principal: Principal;
  /** The awaited Next 15 route params; an empty object for routes without any. */
  params: P;
}

export interface AuthzOptions {
  /**
   * For write endpoints of the local provider: answer 409 when roles are
   * owned by Rollekatalog (ACCESS_SOURCE=rollekatalog). Checked after the
   * capability, so a caller without access learns nothing about the mode.
   */
  requireLocalSource?: boolean;
}

// Next 15 passes `{ params: Promise<...> }` as 2nd arg. The exported handler's
// type must be exactly that (not optional/undefined-able): next build's route
// type check rejects anything else. The body still tolerates a missing context.
type RouteContext<P> = { params: Promise<P> };

const FORBIDDEN = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 });

// Re-exported so route handlers keep importing the guard from one place.
export { hasCapability };

/** null when the principal holds the capability, otherwise a 403 (and a denial event). */
export function requireCapability(
  principal: Principal,
  capability: Capability,
  entity?: { type: string; id: string },
): NextResponse | null {
  if (hasCapability(principal, capability)) return null;
  recordAuthzDenied({
    actorUserId: principal.userId,
    required: capability,
    reason: principal.disabled ? 'disabled' : 'missing_capability',
    entityType: entity?.type,
    entityId: entity?.id,
  });
  return FORBIDDEN();
}

/**
 * Resource-level denial: a resource outside the caller's scope is hidden
 * (404, so its existence does not leak); one in scope but lacking the
 * capability is 403. null means the caller may proceed.
 *
 * `inScope` is the answer to isOrgUnitWithinScope for a capability whose
 * scope the caller is allowed to see (e.g. directory.read), not necessarily
 * the capability being checked here.
 */
export function notFoundOrForbidden(
  principal: Principal,
  capability: Capability,
  inScope: boolean,
  entity?: { type: string; id: string },
): NextResponse | null {
  if (!inScope) {
    recordAuthzDenied({
      actorUserId: principal.userId,
      required: capability,
      reason: 'out_of_scope',
      entityType: entity?.type,
      entityId: entity?.id,
    });
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return requireCapability(principal, capability, entity);
}

/**
 * Route-handler wrapper: session (401) -> live principal -> disabled (403) ->
 * capability (403) -> handler. Composed with withHandler so anything thrown,
 * including from resolvePrincipal, becomes the standard JSON 500.
 * A null capability means "any signed-in, non-disabled user".
 *
 *   export const GET = withAuthz('admin/users/GET', 'directory.read', async (req, { principal, params }) => ...);
 */
export function withAuthz<P = Record<string, never>>(
  label: string,
  capability: Capability | null,
  handler: (req: NextRequest, ctx: AuthzContext<P>) => Response | Promise<Response>,
  options: AuthzOptions = {},
): (req: NextRequest, routeCtx: RouteContext<P>) => Promise<Response> {
  return withHandler(label, async (req: NextRequest, routeCtx: RouteContext<P>) => {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const principal = await resolvePrincipal(session.user.id);
    if (principal.disabled) {
      recordAuthzDenied({ actorUserId: principal.userId, required: capability ?? 'login', reason: 'disabled' });
      return FORBIDDEN();
    }
    if (capability) {
      const denied = requireCapability(principal, capability);
      if (denied) return denied;
    }
    if (options.requireLocalSource && accessSource() !== 'local') {
      recordAuthzDenied({ actorUserId: principal.userId, required: capability ?? 'login', reason: 'wrong_source' });
      return NextResponse.json({ error: 'Roller styres af Rollekatalog' }, { status: 409 });
    }

    const params = (routeCtx?.params ? await routeCtx.params : {}) as P;
    return handler(req, { session, principal, params });
  });
}

/**
 * Page gate for server components / layouts. null = not signed in. A disabled
 * principal is returned as-is (disabled: true); the caller must treat it as no access.
 */
export async function getPrincipalForServerComponent(): Promise<Principal | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  return resolvePrincipal(session.user.id);
}

/**
 * Why a signed-in principal may not use the app at all, or null. A disabled
 * person is always refused; a person with no role only when
 * REQUIRE_ROLE_TO_LOGIN=true (otherwise tt-bruger is implicit).
 */
export function loginRefusal(principal: Principal): 'disabled' | 'no_role' | null {
  if (principal.disabled) return 'disabled';
  if (requireRoleToLogin() && principal.roles.length === 0) return 'no_role';
  return null;
}

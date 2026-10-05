import { NextResponse } from 'next/server';
import { withAuthz } from '@/lib/authz/guard';
import { accessSource } from '@/lib/authz/config';

// Advisory only: the UI uses this to decide what to show. The server
// re-checks every capability and scope on every request, so nothing here is
// ever a grant. Only whitelisted fields are returned: no tokens, no session
// internals, and no unit names (a scope is reported as org unit ids).
export const GET = withAuthz('me/GET', null, async (_req, { session, principal }) => {
  const source = accessSource();
  const scopes = Object.fromEntries(
    Object.entries(principal.scopes).map(([capability, scope]) => [
      capability,
      {
        global: scope.global,
        roots: scope.roots.map((r) => ({ orgUnitUuid: r.orgUnitUuid, includeDescendants: r.includeDescendants })),
      },
    ]),
  );
  return NextResponse.json({
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    roles: principal.roles,
    capabilities: principal.capabilities,
    scopes,
    source,
    readOnly: source !== 'local',
  });
});

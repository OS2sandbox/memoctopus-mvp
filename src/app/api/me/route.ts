import { NextResponse } from 'next/server';
import { withAuthz } from '@/lib/authz/guard';
import { accessSource, localAdminEnabled, requireRoleToLogin } from '@/lib/authz/config';

// Advisory only: the UI uses this to decide what to show. The server
// re-checks every capability on every request, so nothing here is ever a
// grant. Only whitelisted fields are returned: no tokens, no session internals.
export const GET = withAuthz('me/GET', null, async (_req, { session, principal }) => {
  const source = accessSource();
  return NextResponse.json({
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    roles: principal.roles,
    capabilities: principal.capabilities,
    source,
    // The kill switch ACCESS_LOCAL_ADMIN (false outside local mode) decides; the UI then shows the read-only card.
    readOnly: !localAdminEnabled(),
    // Whether a person without a role is refused at login (no implicit bruger); the admin list words "no roles" by it.
    requireRoleToLogin: requireRoleToLogin(),
  });
});

// Client-side view of GET /api/me. Pure (no env, no DB) so it can be bundled
// into client components. Everything derived here is advisory: the server
// re-checks every capability and scope on every request.
import { visibleSections, type AdminSection } from './admin-sections';
import type { AccessSource } from './config';
import type { Capability, CapabilityScope, Principal, RoleKey } from './types';

export interface MeResponse {
  user: { id: string; name: string; email: string };
  roles: RoleKey[];
  capabilities: Capability[];
  scopes: Partial<Record<Capability, CapabilityScope>>;
  source: AccessSource;
  readOnly: boolean;
}

/** Shape check for an untrusted JSON body; false means "treat as no data". */
export function isMeResponse(value: unknown): value is MeResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const user = v.user as Record<string, unknown> | null | undefined;
  return (
    typeof user === 'object' &&
    user !== null &&
    typeof user.id === 'string' &&
    Array.isArray(v.roles) &&
    Array.isArray(v.capabilities) &&
    typeof v.scopes === 'object' &&
    v.scopes !== null &&
    (v.source === 'local' || v.source === 'rollekatalog') &&
    typeof v.readOnly === 'boolean'
  );
}

/** /api/me answers 403 for disabled users, so a successful response is never disabled. */
export function meToPrincipal(me: MeResponse): Principal {
  return {
    userId: me.user.id,
    directoryUserUuid: null,
    roles: me.roles,
    capabilities: me.capabilities,
    scopes: me.scopes,
    disabled: false,
    source: me.source,
  };
}

export function visibleSectionsForMe(me: MeResponse): AdminSection[] {
  return visibleSections(meToPrincipal(me));
}

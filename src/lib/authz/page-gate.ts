// Server-side gates for the admin pages. The admin layout does not re-render
// on client-side navigation between its pages, so each page repeats the check
// for its own section instead of trusting the layout (or the hidden nav link).
import { notFound, redirect } from 'next/navigation';
import { canAccessSection, visibleSections, type AdminSectionKey, type AdminSection } from './admin-sections';
import { safeLogError } from '@/lib/audit/safe-log';
import { getPrincipalForServerComponent } from './guard';
import type { Principal } from './types';

/**
 * The access check itself failed (e.g. the database is unreachable), as opposed to
 * "not allowed". Fail closed: the admin layout turns it into the same retry screen the
 * (app) layout shows, and (app)/admin/error.tsx does the same for a page that throws it.
 */
export class AccessCheckUnavailableError extends Error {
  constructor() {
    super('access check unavailable');
    this.name = 'AccessCheckUnavailableError';
  }
}

async function lookupPrincipal(label: string): Promise<Principal | null> {
  try {
    return await getPrincipalForServerComponent();
  } catch (err) {
    safeLogError(label, err);
    throw new AccessCheckUnavailableError();
  }
}

/**
 * Where a request without a valid session goes. The marker lets the middleware serve the
 * landing page (and drop the dead cookie) instead of bouncing back to /dashboard.
 */
export const SESSION_EXPIRED_URL = '/?expired=1';

/** Not signed in -> '/'. No capability for any admin section -> 404 (hides that the area exists). */
export async function requireAnyAdminSection(): Promise<{ principal: Principal; sections: AdminSection[] }> {
  const principal = await lookupPrincipal('admin layout principal');
  if (!principal) redirect(SESSION_EXPIRED_URL);
  const sections = visibleSections(principal);
  if (principal.disabled || sections.length === 0) notFound();
  return { principal, sections };
}

export async function requireAdminSection(key: AdminSectionKey): Promise<Principal> {
  const principal = await lookupPrincipal('admin page principal');
  if (!principal) redirect(SESSION_EXPIRED_URL);
  if (principal.disabled || !canAccessSection(principal, key)) notFound();
  return principal;
}

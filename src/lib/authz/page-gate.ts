// Server-side gates for the admin pages. The admin layout does not re-render
// on client-side navigation between its pages, so each page repeats the check
// for its own section instead of trusting the layout (or the hidden nav link).
import { notFound, redirect } from 'next/navigation';
import { canAccessSection, visibleSections, type AdminSectionKey, type AdminSection } from './admin-sections';
import { getPrincipalForServerComponent } from './guard';
import type { Principal } from './types';

/** Not signed in -> '/'. No capability for any admin section -> 404 (hides that the area exists). */
export async function requireAnyAdminSection(): Promise<{ principal: Principal; sections: AdminSection[] }> {
  const principal = await getPrincipalForServerComponent();
  if (!principal) redirect('/');
  const sections = visibleSections(principal);
  if (principal.disabled || sections.length === 0) notFound();
  return { principal, sections };
}

export async function requireAdminSection(key: AdminSectionKey): Promise<Principal> {
  const principal = await getPrincipalForServerComponent();
  if (!principal) redirect('/');
  if (principal.disabled || !canAccessSection(principal, key)) notFound();
  return principal;
}

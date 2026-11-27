import { redirect } from 'next/navigation';
import { requireAnyAdminSection } from '@/lib/authz/page-gate';

// /admin has no page of its own: it sends the user to the first section they may open
// (the same order as the tab bar). Not signed in -> '/', no admin section -> 404, both
// decided by requireAnyAdminSection. A lookup failure propagates to the admin error boundary.
export default async function AdminIndexPage() {
  const { sections } = await requireAnyAdminSection();
  redirect(sections[0].href);
}

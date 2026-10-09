import { OrganisationAdmin } from '@/components/admin/OrganisationAdmin';
import { requireAdminSection } from '@/lib/authz/page-gate';

export default async function OrganisationPage() {
  await requireAdminSection('organisation');
  return <OrganisationAdmin />;
}

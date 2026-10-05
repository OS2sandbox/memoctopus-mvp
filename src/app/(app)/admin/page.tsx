import { AdminOverview } from '@/components/admin/AdminOverview';
import { requireAdminSection } from '@/lib/authz/page-gate';

export default async function AdminPage() {
  await requireAdminSection('overview');
  return <AdminOverview />;
}

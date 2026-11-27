import { UsersAdmin } from '@/components/admin/UsersAdmin';
import { requireAdminSection } from '@/lib/authz/page-gate';

export default async function BrugerePage() {
  await requireAdminSection('users');
  return <UsersAdmin />;
}

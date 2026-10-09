import { AuditLog } from '@/components/admin/AuditLog';
import { requireAdminSection } from '@/lib/authz/page-gate';

export default async function LogPage() {
  await requireAdminSection('log');
  return <AuditLog />;
}

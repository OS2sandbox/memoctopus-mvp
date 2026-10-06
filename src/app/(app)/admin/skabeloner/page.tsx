import { CentralTemplatesAdmin } from '@/components/admin/CentralTemplatesAdmin';
import { requireAdminSection } from '@/lib/authz/page-gate';

export default async function SkabelonerAdminPage() {
  await requireAdminSection('templates');
  return <CentralTemplatesAdmin />;
}

import { AdminNav } from '@/components/admin/AdminNav';
import { ToastProvider } from '@/components/ui/toast';
import { requireAnyAdminSection } from '@/lib/authz/page-gate';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Authoritative gate for the whole /admin tree, same idea as (app)/layout.tsx:
  // the principal is read live from the DB, never from the cookie. A user with no
  // admin capability gets a 404 so the area's existence is not revealed.
  const { sections } = await requireAnyAdminSection();

  return (
    <ToastProvider>
      <div className="mx-auto max-w-[1040px] px-6 pt-8">
        <AdminNav sections={sections.map(({ key, href, label }) => ({ key, href, label }))} />
      </div>
      {children}
    </ToastProvider>
  );
}

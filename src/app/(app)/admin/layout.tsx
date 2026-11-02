import { AdminNav } from '@/components/admin/AdminNav';
import { ToastProvider } from '@/components/ui/toast';
import { AccessUnavailable } from '@/components/layout/AccessUnavailable';
import { AccessCheckUnavailableError, requireAnyAdminSection } from '@/lib/authz/page-gate';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Authoritative gate for the whole /admin tree, same idea as (app)/layout.tsx:
  // the principal is read live from the DB, never from the cookie. A user with no
  // admin capability gets a 404 so the area's existence is not revealed.
  // If the lookup itself fails (database down) the (app) layout's retry screen is shown
  // here too, not the generic error page. redirect()/notFound() are rethrown untouched.
  let sections: Awaited<ReturnType<typeof requireAnyAdminSection>>['sections'];
  try {
    ({ sections } = await requireAnyAdminSection());
  } catch (err) {
    if (err instanceof AccessCheckUnavailableError) return <AccessUnavailable embedded />;
    throw err;
  }

  return (
    <ToastProvider>
      <div className="mx-auto max-w-[1040px] px-6 pt-8">
        <AdminNav sections={sections.map(({ key, href, label }) => ({ key, href, label }))} />
      </div>
      {children}
    </ToastProvider>
  );
}

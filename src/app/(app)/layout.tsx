import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { TopBar } from '@/components/layout/TopBar';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect('/login');
  }

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <TopBar user={{ name: session.user.name, email: session.user.email }} />
      <main>{children}</main>
    </div>
  );
}

import { Suspense } from 'react';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen flex items-center justify-center p-7"
      style={{ background: 'var(--bg-2)' }}
    >
      <Suspense>{children}</Suspense>
    </div>
  );
}

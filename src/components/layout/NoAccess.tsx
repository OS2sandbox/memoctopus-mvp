'use client';

import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth-client';

type NoAccessReason = 'disabled' | 'no_role';

const TEXT: Record<NoAccessReason, string> = {
  disabled: 'Din konto er deaktiveret. Kontakt din administrator.',
  no_role: 'Du har ikke fået tildelt en rolle endnu. Kontakt din administrator.',
};

// Shown instead of the app shell, so there is no TopBar or nav to click into.
export function NoAccess({ reason }: { reason: NoAccessReason }) {
  const leave = () => {
    signOut()
      .catch((err) => console.error('signOut failed', err))
      .finally(() => window.location.assign('/'));
  };
  return (
    <main className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-xl font-semibold text-[var(--ink)]">Ingen adgang</h1>
      <p className="mt-3 text-sm text-[var(--muted)]">{TEXT[reason]}</p>
      <Button type="button" variant="outline" className="mt-6" onClick={leave}>
        Log ud
      </Button>
    </main>
  );
}

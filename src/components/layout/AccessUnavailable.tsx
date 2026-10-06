'use client';

import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth-client';

// Shown instead of the app shell when the access check itself failed (e.g. the
// database is unreachable). Fail closed: no TopBar, no children, just a retry.
export function AccessUnavailable() {
  const retry = () => window.location.reload();
  const leave = () => {
    signOut()
      .catch((err) => console.error('signOut failed', err))
      .finally(() => window.location.assign('/'));
  };
  return (
    <main className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-xl font-semibold text-[var(--ink)]">Adgangskontrol er midlertidigt utilgængelig</h1>
      <p className="mt-3 text-sm text-[var(--muted)]">Adgangskontrol er midlertidigt utilgængelig. Prøv igen om lidt.</p>
      <div className="mt-6 flex justify-center gap-3">
        <Button type="button" onClick={retry}>
          Prøv igen
        </Button>
        <Button type="button" variant="outline" onClick={leave}>
          Log ud
        </Button>
      </div>
    </main>
  );
}

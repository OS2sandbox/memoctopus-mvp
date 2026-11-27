'use client';

import { Button } from '@/components/ui/button';
import { signOutAfterFlush } from '@/lib/sign-out';

// Shown instead of the app shell when the access check itself failed (e.g. the
// database is unreachable). Fail closed: no TopBar, no children, just a retry.
export function AccessUnavailable({ embedded = false }: { embedded?: boolean } = {}) {
  // Inside the app shell there is already a <main>; a second one would be invalid.
  const Root = embedded ? 'div' : 'main';
  const retry = () => window.location.reload();
  const leave = () => {
    void signOutAfterFlush().finally(() => window.location.assign('/'));
  };
  return (
    <Root className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-xl font-semibold text-[var(--ink)]">Adgangskontrol er midlertidigt utilgængelig</h1>
      <p className="mt-3 text-sm text-[var(--muted)]">Vi kunne ikke kontrollere dine rettigheder lige nu. Prøv igen om lidt; kontakt din administrator, hvis det fortsætter.</p>
      <div className="mt-6 flex justify-center gap-3">
        <Button type="button" onClick={retry}>
          Prøv igen
        </Button>
        <Button type="button" variant="outline" onClick={leave}>
          Log ud
        </Button>
      </div>
    </Root>
  );
}

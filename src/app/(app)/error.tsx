'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

// Scoped error boundary for the authenticated app routes. Catches render/data
// throws (e.g. an unhandled rejection in a Server Component) and offers recovery
// instead of a blank page. `error.digest` ties the screen to a server-side log.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app-error-boundary]', error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: 'calc(100vh - 56px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 440, textAlign: 'center' }}>
        <h1 style={{ fontSize: 22, fontWeight: 300, color: 'var(--ink)', margin: '0 0 8px' }}>
          Noget gik galt
        </h1>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 20px', lineHeight: 1.6 }}>
          Vi kunne ikke vise denne side. Prøv igen, eller gå tilbage til forsiden.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <Button onClick={() => reset()}>Prøv igen</Button>
          <Button variant="outline" asChild>
            <Link href="/dashboard">Til forsiden</Link>
          </Button>
        </div>
        {error.digest && (
          <p style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 16, fontFamily: 'var(--mono)' }}>
            Fejl-id: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}

'use client';

import { useEffect } from 'react';

// Root error boundary. Catches throws that escape the root layout itself, so it
// must render its own <html>/<body> and cannot rely on the app stylesheet — uses
// inline styles with literal colours. `error.digest` ties the screen to a server log.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global-error]', error);
  }, [error]);

  return (
    <html lang="da">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: '#fafafa',
          color: '#111',
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px' }}>Noget gik helt galt</h1>
          <p style={{ fontSize: 14, color: '#666', margin: '0 0 20px', lineHeight: 1.6 }}>
            Der opstod en uventet fejl. Prøv at indlæse siden igen.
          </p>
          <button
            onClick={() => reset()}
            style={{
              height: 44,
              padding: '0 20px',
              borderRadius: 8,
              border: 'none',
              background: '#111',
              color: '#fff',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Prøv igen
          </button>
          {error.digest && (
            <p style={{ fontSize: 11, color: '#999', marginTop: 16, fontFamily: 'monospace' }}>
              Fejl-id: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}

'use client';

import { useEffect } from 'react';
import { AccessUnavailable } from '@/components/layout/AccessUnavailable';

// Error boundary for the admin PAGES. The admin layout does not re-render on client-side
// navigation, so a page whose own gate cannot reach the database (AccessCheckUnavailableError)
// throws here. In production Next strips the message of a server error, so the class cannot
// be recognised on the client; every error from an admin page gets the same fail-closed retry
// screen, which is what the (app) layout shows when the access check is unavailable.
// This boundary sits INSIDE admin/layout.tsx, so it never sees a layout error: the layout
// handles its own lookup failure.
export default function AdminError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    // Only the digest, which ties the screen to the server-side log; never the message.
    console.error('[admin-error-boundary]', error.digest ?? 'no-digest');
  }, [error]);

  return <AccessUnavailable embedded />;
}

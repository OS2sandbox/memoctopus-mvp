'use client';

import { useEffect } from 'react';
import { setStorageUserId } from '@/lib/storage/scope';

// Binds client-side storage (IndexedDB) to the signed-in user. Rendered at the top
// of the authenticated layout with the server-validated user id, so every storage
// access below it reads/writes that user's per-user database — never another user's.
export function StorageScope({ userId, children }: { userId: string; children: React.ReactNode }) {
  // Set during render on the client so storage reads in children resolve to this
  // user's database immediately on first paint (before child effects run).
  if (typeof window !== 'undefined') setStorageUserId(userId);
  // Re-apply if the user changes within the session (sign out → sign in).
  useEffect(() => {
    setStorageUserId(userId);
  }, [userId]);
  return <>{children}</>;
}

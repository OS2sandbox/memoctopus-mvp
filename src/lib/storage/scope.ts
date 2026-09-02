// Per-user scope for client-side storage.
//
// IndexedDB is scoped to the ORIGIN, not the signed-in user. Without this, every
// user on the same browser shares ONE database and sees each other's meetings — a
// privacy leak. <StorageScope> (at the top of the authenticated layout) sets the
// active user id from the auth session; getDB() uses it to open a per-user database
// (`referat-db-u-<id>`), so a different user signing in reads a separate database.

let currentUserId: string | null = null;
let waiters: Array<(id: string) => void> = [];

// Set the active user. Idempotent: re-setting the same id is a no-op. Setting a new
// id (a different user signed in) makes the next getDB() open that user's database.
export function setStorageUserId(userId: string | null): void {
  if (userId === currentUserId) return;
  currentUserId = userId;
  if (userId) {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve(userId);
  }
}

export function getStorageUserId(): string | null {
  return currentUserId;
}

// Resolves with the active user id, waiting if a storage call raced ahead of
// <StorageScope> on first mount. getDB() never opens an unscoped database.
export function waitForStorageUserId(): Promise<string> {
  if (currentUserId) return Promise.resolve(currentUserId);
  return new Promise<string>((resolve) => {
    waiters.push(resolve);
  });
}

// Test-only: reset module state between tests.
export function __resetStorageScope(): void {
  currentUserId = null;
  waiters = [];
}

import { useSyncExternalStore } from 'react';

// Whether the app can reach its server right now. The browser's navigator.onLine
// only notices a missing network interface, not a dead Wi-Fi or a captive portal,
// so two network failures in a row also count as offline. Any request that gets a
// response, or the browser's `online` event, brings it back.

const FAILURES_UNTIL_OFFLINE = 2;

let consecutiveFailures = 0;
const listeners = new Set<() => void>();

function isOnline(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return consecutiveFailures < FAILURES_UNTIL_OFFLINE;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function setFailures(count: number): void {
  const before = isOnline();
  consecutiveFailures = count;
  if (isOnline() !== before) notify();
}

if (typeof window !== 'undefined') {
  // Every `online` event notifies, even when the state looked online already: it is
  // the moment for waiting work (the batch queue) to try again instead of backing off.
  window.addEventListener('online', () => {
    consecutiveFailures = 0;
    notify();
  });
  window.addEventListener('offline', notify);
}

export const connectivity = {
  isOnline,
  // A request that got no response at all (network error or timeout).
  reportNetworkFailure: () => setFailures(consecutiveFailures + 1),
  // A request that got a response, whatever its status: the server is reachable.
  reportSuccess: () => setFailures(0),
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useConnectivity(): boolean {
  return useSyncExternalStore(connectivity.subscribe, isOnline, () => true);
}

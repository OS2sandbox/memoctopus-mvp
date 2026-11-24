import { useSyncExternalStore } from 'react';

// "Leaving now would interrupt a recording." Set by whatever is recording; read by
// navigation (TopBar) through useLeaveGuard, and by the browser through the
// beforeunload confirmation that is attached only while the guard is up.

let guarded = false;
const listeners = new Set<() => void>();

function confirmLeave(event: BeforeUnloadEvent): void {
  event.preventDefault();
  // Older browsers show the confirmation only when returnValue is set.
  event.returnValue = '';
}

export function setLeaveGuard(on: boolean): void {
  if (on === guarded) return;
  guarded = on;
  if (on) window.addEventListener('beforeunload', confirmLeave);
  else window.removeEventListener('beforeunload', confirmLeave);
  for (const listener of listeners) listener();
}

export function isLeaveGuarded(): boolean {
  return guarded;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLeaveGuard(): boolean {
  return useSyncExternalStore(subscribe, isLeaveGuarded, () => false);
}

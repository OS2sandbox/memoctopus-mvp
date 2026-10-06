// Durable queue for client-reported audit events (browser only).
//
// The app is used on flaky connections, so an event must survive a lost request or
// a closed tab and be delivered on a later load. The queue lives in its OWN small
// IndexedDB database per user, never in the meetings database: that leaves the main
// schema version untouched, and users sharing a browser never see each other's
// queue (same per-user naming idea as storage/db.ts).
//
// Everything here is best-effort: a failing IndexedDB makes the functions return
// "nothing queued" instead of throwing, because reporting must never break the
// storage operation that triggered it.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export const OUTBOX_MAX_EVENTS = 1000;
export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;

export interface OutboxEvent {
  clientEventId: string;
  type: string;
  entityId: string;
  details: Record<string, unknown>;
  /** When the user action happened (ISO). The server clamps it. */
  occurredAt: string;
  /** When it entered the queue (ms); drives TTL and oldest-first eviction. */
  queuedAt: number;
  attempts: number;
  /** Earliest time (ms) the next delivery attempt is allowed (backoff). */
  nextAttemptAt: number;
}

interface OutboxDB extends DBSchema {
  events: {
    key: string;
    value: OutboxEvent;
    indexes: { 'by-queued': number };
  };
}

export function outboxDbName(userId: string): string {
  return `referat-audit-outbox-u-${userId}`;
}

/** False on the server, in tests without IndexedDB and in browsers that block it. */
export function outboxAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

const opened = new Map<string, Promise<IDBPDatabase<OutboxDB>>>();

function open(userId: string): Promise<IDBPDatabase<OutboxDB>> {
  let p = opened.get(userId);
  if (!p) {
    const forget = () => {
      // Only drop our own entry: a newer connection may already have replaced it.
      if (opened.get(userId) === p) opened.delete(userId);
    };
    p = openDB<OutboxDB>(outboxDbName(userId), 1, {
      upgrade(db) {
        const store = db.createObjectStore('events', { keyPath: 'clientEventId' });
        store.createIndex('by-queued', 'queuedAt');
      },
      // Another tab wants to upgrade or delete the database: let go of it, and do not
      // keep handing out a connection that is about to be closed.
      blocking() {
        forget();
        void p?.then((db) => db.close()).catch(() => undefined);
      },
      // The browser closed the connection on its own (storage cleared, profile removed).
      terminated() {
        forget();
      },
    });
    // A failed open must not be cached forever (private mode, blocked storage).
    p.catch(() => opened.delete(userId));
    opened.set(userId, p);
  }
  return p;
}

/** Retry delay after `attempts` failed deliveries: 5 s, 10 s, 20 s ... capped at 15 min. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

/** Queue one event; evicts the oldest ones beyond the bound. Returns false if it could not be stored. */
export async function addToOutbox(
  userId: string,
  event: Pick<OutboxEvent, 'clientEventId' | 'type' | 'entityId' | 'details' | 'occurredAt'>,
  now = Date.now(),
): Promise<boolean> {
  if (!outboxAvailable()) return false;
  try {
    const db = await open(userId);
    await db.put('events', { ...event, queuedAt: now, attempts: 0, nextAttemptAt: now });
    const size = await db.count('events');
    if (size > OUTBOX_MAX_EVENTS) {
      const oldest = await db.getAllKeysFromIndex('events', 'by-queued', undefined, size - OUTBOX_MAX_EVENTS);
      for (const key of oldest) await db.delete('events', key);
    }
    return true;
  } catch {
    return false;
  }
}

/** Drops events older than the TTL, then returns up to `limit` events that are due, oldest first. */
export async function takeDue(userId: string, limit: number, now = Date.now()): Promise<OutboxEvent[]> {
  if (!outboxAvailable()) return [];
  try {
    const db = await open(userId);
    const all = await db.getAllFromIndex('events', 'by-queued');
    const due: OutboxEvent[] = [];
    for (const ev of all) {
      if (now - ev.queuedAt > OUTBOX_TTL_MS) {
        await db.delete('events', ev.clientEventId);
      } else if (ev.nextAttemptAt <= now && due.length < limit) {
        due.push(ev);
      }
    }
    return due;
  } catch {
    return [];
  }
}

/** Removes events after the server confirmed them (or rejected them for good). */
export async function removeFromOutbox(userId: string, ids: string[]): Promise<void> {
  if (!outboxAvailable() || ids.length === 0) return;
  try {
    const db = await open(userId);
    for (const id of ids) await db.delete('events', id);
  } catch {
    // Left in the queue: redelivery is idempotent on the server.
  }
}

/** Counts a failed attempt and pushes the next attempt out by the backoff. */
export async function markFailed(userId: string, ids: string[], now = Date.now()): Promise<void> {
  if (!outboxAvailable() || ids.length === 0) return;
  try {
    const db = await open(userId);
    for (const id of ids) {
      const ev = await db.get('events', id);
      if (!ev) continue;
      const attempts = ev.attempts + 1;
      await db.put('events', { ...ev, attempts, nextAttemptAt: now + backoffMs(attempts) });
    }
  } catch {
    // Best effort.
  }
}

/** Test only: forget cached connections. */
export function __resetOutbox(): void {
  opened.clear();
}

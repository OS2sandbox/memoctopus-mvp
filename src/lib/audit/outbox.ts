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

// ─── events lost before delivery ─────────────────────────────────────────────
//
// An event that leaves the queue WITHOUT being delivered (evicted because the queue is full,
// expired after 7 days, refused for good by the server, or never queued because storage failed)
// is counted here and reported with the next successful flush as one audit.events_dropped row
// (reason client_outbox), so a loss is a counted event and not silence. The count lives in
// localStorage (per user; IndexedDB would need a schema bump) with an in-memory fallback, and
// carries an id that changes whenever the count does, so a retry after a lost response is
// idempotent on the server while a later, larger count is a new report.
export interface DroppedLocally {
  count: number;
  clientEventId: string;
}

const DROPPED_KEY = (userId: string) => `referat-audit-dropped-u-${userId}`;
const droppedMemory = new Map<string, DroppedLocally>();

function newId(): string {
  return crypto.randomUUID();
}

function readDropped(userId: string): DroppedLocally | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DROPPED_KEY(userId)) : null;
    if (raw) {
      const v = JSON.parse(raw) as Partial<DroppedLocally>;
      if (typeof v.count === 'number' && v.count > 0 && typeof v.clientEventId === 'string') {
        return { count: v.count, clientEventId: v.clientEventId };
      }
    }
  } catch {
    // Fall through to the in-memory copy.
  }
  return droppedMemory.get(userId) ?? null;
}

function writeDropped(userId: string, value: DroppedLocally | null): void {
  if (value) droppedMemory.set(userId, value);
  else droppedMemory.delete(userId);
  try {
    if (typeof localStorage === 'undefined') return;
    if (value) localStorage.setItem(DROPPED_KEY(userId), JSON.stringify(value));
    else localStorage.removeItem(DROPPED_KEY(userId));
  } catch {
    // The in-memory copy still reports it during this page load.
  }
}

/** Count `n` events that were lost before delivery. Never throws. */
export function addDroppedLocally(userId: string, n: number): void {
  if (n <= 0) return;
  try {
    const current = readDropped(userId);
    writeDropped(userId, { count: Math.min((current?.count ?? 0) + n, 1_000_000), clientEventId: newId() });
  } catch {
    // Best effort.
  }
}

/** What is waiting to be reported, or null. */
export function getDroppedLocally(userId: string): DroppedLocally | null {
  return readDropped(userId);
}

/** The server confirmed `reported` lost events: subtract them (more may have been added meanwhile). */
export function clearDroppedLocally(userId: string, reported: number): void {
  try {
    const current = readDropped(userId);
    if (!current) return;
    const left = current.count - reported;
    writeDropped(userId, left > 0 ? { count: left, clientEventId: newId() } : null);
  } catch {
    // Best effort.
  }
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
    // One transaction: the event and the eviction of the oldest ones beyond the bound go in together.
    const tx = db.transaction('events', 'readwrite');
    await tx.store.put({ ...event, queuedAt: now, attempts: 0, nextAttemptAt: now });
    const size = await tx.store.count();
    let evicted = 0;
    if (size > OUTBOX_MAX_EVENTS) {
      const oldest = await tx.store.index('by-queued').getAllKeys(undefined, size - OUTBOX_MAX_EVENTS);
      await Promise.all(oldest.map((key) => tx.store.delete(key)));
      evicted = oldest.length;
    }
    await tx.done;
    addDroppedLocally(userId, evicted);
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
    // An empty queue (the usual case at every flush) costs one count, not a full read.
    if ((await db.count('events')) === 0) return [];
    const tx = db.transaction('events', 'readwrite');
    const all = await tx.store.index('by-queued').getAll();
    const due: OutboxEvent[] = [];
    const expired: string[] = [];
    for (const ev of all) {
      if (now - ev.queuedAt > OUTBOX_TTL_MS) expired.push(ev.clientEventId);
      else if (ev.nextAttemptAt <= now && due.length < limit) due.push(ev);
    }
    await Promise.all(expired.map((id) => tx.store.delete(id)));
    await tx.done;
    addDroppedLocally(userId, expired.length);
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
    const tx = db.transaction('events', 'readwrite');
    await Promise.all(ids.map((id) => tx.store.delete(id)));
    await tx.done;
  } catch {
    // Left in the queue: redelivery is idempotent on the server.
  }
}

/** Counts a failed attempt and pushes the next attempt out by the backoff. */
export async function markFailed(userId: string, ids: string[], now = Date.now()): Promise<void> {
  if (!outboxAvailable() || ids.length === 0) return;
  try {
    const db = await open(userId);
    const tx = db.transaction('events', 'readwrite');
    await Promise.all(
      ids.map(async (id) => {
        const ev = await tx.store.get(id);
        if (!ev) return;
        const attempts = ev.attempts + 1;
        await tx.store.put({ ...ev, attempts, nextAttemptAt: now + backoffMs(attempts) });
      }),
    );
    await tx.done;
  } catch {
    // Best effort.
  }
}

/** Test only: forget cached connections. */
export function __resetOutbox(): void {
  opened.clear();
  droppedMemory.clear();
}

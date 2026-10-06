// Browser side of the client-reported audit events (meeting.* in the catalogue).
//
// Meetings live only in this browser's IndexedDB, so the server cannot observe
// what happens to them. The storage layer therefore reports each lifecycle action
// here; events are queued in a small per-user IndexedDB outbox (./outbox) and
// delivered to POST /api/audit/client-events. They are SELF-REPORTED: the server
// takes actor, IP and time from the session and request, never from this payload,
// but it cannot know that the described action really happened.
//
// reportAuditEvent() is fire-and-forget: it returns synchronously, never throws
// and never delays the storage operation. It does nothing on the server, in tests
// without IndexedDB, or before the signed-in user is known.
//
// Nothing but opaque ids, counts and codes may be passed in `details` (the server
// enforces the same catalogue). Never titles, names, text or file names.
import type { EventDetails, EventType } from './events';
import { addToOutbox, markFailed, outboxAvailable, removeFromOutbox, takeDue, type OutboxEvent } from './outbox';
import { getStorageUserId } from '@/lib/storage/scope';

type ClientEventType = Extract<EventType, `meeting.${string}`>;

type DetailsArgs<T extends EventType> = Record<string, never> extends EventDetails<T>
  ? [details?: EventDetails<T>]
  : [details: EventDetails<T>];

const ENDPOINT = '/api/audit/client-events';
/** Server limit is 50 events and about 32 KB per request. */
const MAX_BATCH = 50;
const MAX_BODY_BYTES = 28_000;
const FLUSH_DEBOUNCE_MS = 1_000;
const FLUSH_INTERVAL_MS = 30_000;
const MAX_ROUNDS_PER_FLUSH = 20;

/**
 * Edit-like events are coalesced to ONE event per meeting+type per window, so
 * autosave does not flood the log. The event is held in memory and sent when the
 * window ends, carrying the LAST details of the window (the final participant
 * count / segment count is the informative one) and the time of the last edit.
 * The held event is written to the outbox early when the tab is hidden or closed;
 * a crash inside the window loses at most that one coalesced event.
 */
export const COALESCE_WINDOW_MS = 30_000;
const COALESCED: ReadonlySet<ClientEventType> = new Set([
  'meeting.minutes_save',
  'meeting.transcript_edit',
  'meeting.participants_edit',
  // MinutesEditor autosaves the title 1.5 s after the last keystroke, so typing with pauses renames repeatedly.
  'meeting.rename',
]);

/**
 * One user action can reach several storage functions (the redact flow calls
 * deleteAudio and then updateMeeting({audioDeleted: true})). Events here are queued
 * at once but a repeat for the same meeting inside the window is swallowed.
 */
const DEDUPE_WINDOW_MS: Partial<Record<ClientEventType, number>> = {
  'meeting.audio_delete': 60_000,
};

interface Pending {
  userId: string;
  event: Omit<OutboxEvent, 'queuedAt' | 'attempts' | 'nextAttemptAt'>;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
const recentlySent = new Map<string, number>();
const flushing = new Set<string>();
const rerun = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;
let uninstall: (() => void) | null = null;

const hasWindow = () => typeof window !== 'undefined' && typeof document !== 'undefined';

function newEventId(): string {
  return crypto.randomUUID();
}

async function commit(userId: string, event: Pending['event']): Promise<void> {
  try {
    await addToOutbox(userId, event);
  } catch {
    // A queue that cannot be written loses the event; the caller carries on.
  }
}

function commitAllPending(): Promise<void> {
  const writes: Promise<void>[] = [];
  for (const [key, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(key);
    writes.push(commit(p.userId, p.event));
  }
  return Promise.all(writes).then(() => undefined);
}

function scheduleFlush(userId: string): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush(userId);
  }, FLUSH_DEBOUNCE_MS);
}

function install(): void {
  if (installed || !hasWindow()) return;
  installed = true;
  const current = () => getStorageUserId();
  const online = () => {
    const u = current();
    if (u) void flush(u);
  };
  const leaving = () => {
    const u = current();
    void commitAllPending().then(() => (u ? flush(u) : undefined));
  };
  const visibility = () => {
    if (document.visibilityState === 'hidden') leaving();
  };
  window.addEventListener('online', online);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', leaving);
  const interval = setInterval(online, FLUSH_INTERVAL_MS);
  uninstall = () => {
    window.removeEventListener('online', online);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', leaving);
    clearInterval(interval);
  };
}

type PostResult = 'ok' | 'transient' | 'rejected';

async function post(events: Array<Omit<OutboxEvent, 'queuedAt' | 'attempts' | 'nextAttemptAt'>>): Promise<PostResult> {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
      // Lets the request finish while the page is unloading.
      keepalive: true,
      credentials: 'same-origin',
    });
    if (res.ok) return 'ok';
    // Not signed in / rate limited / server trouble: keep the events and retry later.
    if (res.status === 401 || res.status === 403 || res.status === 408 || res.status === 429 || res.status >= 500) {
      return 'transient';
    }
    return 'rejected';
  } catch {
    return 'transient';
  }
}

const wire = ({ clientEventId, type, entityId, details, occurredAt }: OutboxEvent) => ({
  clientEventId,
  type,
  entityId,
  details,
  occurredAt,
});

/** Delivers one batch. Returns true when the queue should keep draining. */
async function sendBatch(userId: string, due: OutboxEvent[]): Promise<boolean> {
  let batch = due;
  while (batch.length > 1 && new TextEncoder().encode(JSON.stringify({ events: batch.map(wire) })).length > MAX_BODY_BYTES) {
    batch = batch.slice(0, Math.ceil(batch.length / 2));
  }
  const result = await post(batch.map(wire));
  if (result === 'ok') {
    await removeFromOutbox(userId, batch.map((e) => e.clientEventId));
    return true;
  }
  if (result === 'transient') {
    await markFailed(userId, batch.map((e) => e.clientEventId));
    return false;
  }
  // The server refused the batch for good (4xx). One bad event must not block the
  // others, so retry them one by one and drop only the ones refused on their own.
  if (batch.length === 1) {
    await removeFromOutbox(userId, [batch[0].clientEventId]);
    return true;
  }
  for (const ev of batch) {
    const single = await post([wire(ev)]);
    if (single === 'transient') {
      await markFailed(userId, [ev.clientEventId]);
      return false;
    }
    await removeFromOutbox(userId, [ev.clientEventId]);
  }
  return true;
}

/** Sends everything that is due for this user. Events leave the queue only after a 2xx. */
export async function flush(userId: string): Promise<void> {
  if (!hasWindow() || !outboxAvailable()) return;
  // The POST carries whatever session cookie the browser holds NOW and the server
  // takes the actor from it. A queue is therefore only delivered while its owner is
  // the signed-in user; after a sign-out/sign-in switch it waits for the owner's next login.
  if (getStorageUserId() !== userId) return;
  if (flushing.has(userId)) {
    rerun.add(userId);
    return;
  }
  flushing.add(userId);
  try {
    for (let round = 0; round < MAX_ROUNDS_PER_FLUSH; round++) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
      if (getStorageUserId() !== userId) break;
      const due = await takeDue(userId, MAX_BATCH);
      if (due.length === 0) break;
      if (!(await sendBatch(userId, due))) break;
    }
  } catch {
    // Reporting never throws; the queue keeps what was not confirmed.
  } finally {
    flushing.delete(userId);
    if (rerun.delete(userId)) scheduleFlush(userId);
  }
}

/**
 * Call once the signed-in user is known (StorageScope): installs the flush
 * triggers (online, tab hidden/closed, timer) and delivers anything a previous
 * page load left in the queue.
 */
export function startAuditReporting(userId: string): void {
  if (!hasWindow() || !outboxAvailable()) return;
  try {
    install();
    scheduleFlush(userId);
  } catch {
    // Never break the page over reporting.
  }
}

/**
 * Report a meeting event. `entityId` is the meeting's opaque uuid.
 *
 *   reportAuditEvent('meeting.participants_edit', meetingId, { participantCount: 3 });
 */
export function reportAuditEvent<T extends ClientEventType>(
  type: T,
  entityId: string,
  ...[details]: DetailsArgs<T>
): void {
  try {
    if (!hasWindow() || !outboxAvailable()) return;
    const userId = getStorageUserId();
    if (!userId) return;
    install();

    const key = `${userId}|${type}|${entityId}`;
    const dedupeMs = DEDUPE_WINDOW_MS[type];
    if (dedupeMs) {
      const last = recentlySent.get(key);
      if (last !== undefined && Date.now() - last < dedupeMs) return;
      recentlySent.set(key, Date.now());
    }

    const event = {
      clientEventId: newEventId(),
      type,
      entityId,
      details: (details ?? {}) as Record<string, unknown>,
      occurredAt: new Date().toISOString(),
    };

    if (COALESCED.has(type)) {
      const held = pending.get(key);
      if (held) {
        // Same window: keep the id, take the latest details and time.
        held.event = { ...held.event, details: event.details, occurredAt: event.occurredAt };
        return;
      }
      const timer = setTimeout(() => {
        const p = pending.get(key);
        if (!p) return;
        pending.delete(key);
        void commit(p.userId, p.event).then(() => scheduleFlush(p.userId));
      }, COALESCE_WINDOW_MS);
      pending.set(key, { userId, event, timer });
      return;
    }

    void commit(userId, event).then(() => scheduleFlush(userId));
  } catch {
    // Reporting must never break the caller.
  }
}

/** Test only. */
export function __resetAuditClient(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  recentlySent.clear();
  flushing.clear();
  rerun.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  uninstall?.();
  uninstall = null;
  installed = false;
}

// Browser side of the client-reported audit events (meeting.* in the catalogue).
//
// Meetings, transcripts, minutes versions and audio live only in this browser's
// IndexedDB, so the server cannot observe what happens to them. The storage layer
// and the screens therefore report each ACTION (view, edit, version switch, playback,
// recording step, delete) here, never its content; events are queued in a small per-user IndexedDB outbox (./outbox) and
// delivered to POST /api/audit/client-events. They are SELF-REPORTED: the server
// takes actor, IP and time from the session and request, never from this payload,
// but it cannot know that the described action really happened: a user (or a script
// in their browser) can omit, forge or replay them, so they are not proof.
//
// reportAuditEvent() is fire-and-forget: it returns synchronously, never throws
// and never delays the storage operation. It does nothing on the server, in tests
// without IndexedDB, or before the signed-in user is known.
//
// Nothing but opaque ids, counts and codes may be passed in `details` (the server
// enforces the same catalogue). Never titles, names, text or file names.
import type { EventDetails, EventType } from './events';
import {
  addDroppedLocally,
  addToOutbox,
  clearDroppedLocally,
  getDroppedLocally,
  markFailed,
  outboxAvailable,
  removeFromOutbox,
  takeDue,
  type DroppedLocally,
  type OutboxEvent,
} from './outbox';
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
 * Chatty event types are coalesced to ONE event per meeting+type per window. The event
 * is held in memory and sent when the window ends, carrying the LAST details of the
 * window and the time of the last occurrence. The held event is written to the outbox
 * early when the tab is hidden or closed; a crash inside the window loses at most that
 * one coalesced event. These are the edit-like events (autosave of the minutes, the
 * participant and speaker lists): "the minutes were edited" is all the log needs, not
 * one row per keystroke. The server-side counterpart is THROTTLED_TYPES.
 */
export const COALESCE_WINDOW_MS = 30_000;
export const COALESCED: Set<ClientEventType> = new Set([
  'meeting.minutes_save',
  'meeting.transcript_edit',
  'meeting.metadata_edit',
  'meeting.participants_edit',
  'meeting.speakers_edit',
]);

/**
 * One user action can reach several storage functions (the redact flow calls
 * deleteAudio and then updateMeeting({audioDeleted: true})), and a screen can render
 * the same view again (switching tabs and back, pressing play twice). Events here are
 * queued at once but a repeat for the same meeting inside the window is swallowed.
 */
const VIEW_DEDUPE_MS = 60_000;
const DEDUPE_WINDOW_MS: Partial<Record<ClientEventType, number>> = {
  'meeting.audio_delete': 60_000,
  'meeting.minutes_view': VIEW_DEDUPE_MS,
  'meeting.transcript_view': VIEW_DEDUPE_MS,
  'meeting.audio_play': VIEW_DEDUPE_MS,
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
// One debounce timer per user: a single shared one would swallow the schedule of a second user.
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
let installed = false;
let uninstall: (() => void) | null = null;

const hasWindow = () => typeof window !== 'undefined' && typeof document !== 'undefined';

function newEventId(): string {
  return crypto.randomUUID();
}

async function commit(userId: string, event: Pending['event']): Promise<void> {
  try {
    // A queue that cannot be written loses the event; it is counted and reported later.
    if (!(await addToOutbox(userId, event))) addDroppedLocally(userId, 1);
  } catch {
    addDroppedLocally(userId, 1);
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
  if (flushTimers.has(userId)) return;
  flushTimers.set(
    userId,
    setTimeout(() => {
      flushTimers.delete(userId);
      void flush(userId);
    }, FLUSH_DEBOUNCE_MS),
  );
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

/**
 * ok = stored; transient = try again later; rejected = refused for good; unknown_type = the
 * server does not know an event type in the batch (a rolling deploy: this browser is newer
 * than the instance it reached), which is transient for THAT event only.
 */
type PostResult = 'ok' | 'transient' | 'rejected' | 'unknown_type';

async function post(
  events: Array<Omit<OutboxEvent, 'queuedAt' | 'attempts' | 'nextAttemptAt'>>,
  droppedLocally?: DroppedLocally,
): Promise<PostResult> {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events, ...(droppedLocally ? { droppedLocally } : {}) }),
      // Lets the request finish while the page is unloading.
      keepalive: true,
      credentials: 'same-origin',
    });
    if (res.ok) return 'ok';
    // Not signed in / rate limited / server trouble: keep the events and retry later.
    // 404 and 405 mean the endpoint is not there (yet): a rolling deploy, where the new
    // client reaches an old instance. That says nothing about the events, so they wait.
    if (
      res.status === 401 ||
      res.status === 403 ||
      res.status === 404 ||
      res.status === 405 ||
      res.status === 408 ||
      res.status === 429 ||
      res.status >= 500
    ) {
      return 'transient';
    }
    if (res.status === 400 && (await isUnknownTypeBody(res))) return 'unknown_type';
    return 'rejected';
  } catch {
    return 'transient';
  }
}

async function isUnknownTypeBody(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as { code?: unknown } | null;
    return body?.code === 'unknown_event_type';
  } catch {
    return false;
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
  // The report of events lost earlier rides along with the first batch that goes out.
  const lost = getDroppedLocally(userId) ?? undefined;
  let result = await post(batch.map(wire), lost);
  const reported = result === 'ok' && !!lost;
  // The report itself may be what an older instance refused: send the events without it.
  if (lost && result === 'rejected') result = await post(batch.map(wire));
  if (result === 'ok') {
    await removeFromOutbox(userId, batch.map((e) => e.clientEventId));
    if (reported && lost) clearDroppedLocally(userId, lost.count);
    return true;
  }
  if (result === 'transient') {
    await markFailed(userId, batch.map((e) => e.clientEventId));
    return false;
  }
  // The server refused the batch (a 4xx other than "try later"), or does not know one of its
  // event types. One bad event must not block the others, so retry them one by one: events the
  // server refuses on their own are dropped (and counted), events of a type it does not know yet
  // wait for the deploy to finish.
  if (batch.length === 1) return settleSingle(userId, batch[0], result);
  let keepDraining = true;
  for (const ev of batch) {
    const single = await post([wire(ev)]);
    if (single === 'transient') {
      await markFailed(userId, [ev.clientEventId]);
      return false;
    }
    if (!(await settleSingle(userId, ev, single))) keepDraining = false;
  }
  return keepDraining;
}

async function settleSingle(userId: string, ev: OutboxEvent, result: PostResult): Promise<boolean> {
  if (result === 'unknown_type') {
    await markFailed(userId, [ev.clientEventId]);
    return true;
  }
  await removeFromOutbox(userId, [ev.clientEventId]);
  if (result === 'rejected') addDroppedLocally(userId, 1);
  return true;
}

/** Reports lost events when there is nothing else to send. */
async function reportDroppedOnly(userId: string): Promise<void> {
  const lost = getDroppedLocally(userId);
  if (!lost) return;
  if ((await post([], lost)) === 'ok') clearDroppedLocally(userId, lost.count);
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
      if (due.length === 0) {
        await reportDroppedOnly(userId);
        break;
      }
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
 * Writes everything still held in memory to the outbox and delivers what is due, now. Await it
 * (with a short timeout, see below) before the session ends: after a sign-out the queue can only
 * be delivered at that person's next login, so events still queued would be late by days.
 * Never throws and never waits longer than `timeoutMs` (default 2 s): signing out must not hang
 * on a slow server.
 */
export async function flushAuditNow(userId: string | null | undefined = getStorageUserId(), timeoutMs = 2_000): Promise<void> {
  if (!userId) return;
  const work = (async () => {
    try {
      await commitAllPending();
      await flush(userId);
    } catch {
      // Reporting never throws.
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
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
 *   reportAuditEvent('meeting.create', meetingId, { origin: 'live' });
 *
 * Returns a `retract` function for an event that is queued at once (not the coalesced ones), or
 * undefined when nothing was queued or the event was swallowed as a repeat. A caller that reports
 * BEFORE it knows the action succeeded (the automatic deletes, which must be reported in the same
 * tick as the delete request because the tab may be frozen right after) calls retract() when the
 * action turns out not to have happened. Retracting removes the event from the outbox; once it
 * has been delivered (about a second later at the earliest) it is too late and the event stays.
 */
export function reportAuditEvent<T extends ClientEventType>(
  type: T,
  entityId: string,
  ...[details]: DetailsArgs<T>
): (() => void) | undefined {
  try {
    if (!hasWindow() || !outboxAvailable()) return undefined;
    const userId = getStorageUserId();
    if (!userId) return undefined;
    install();

    // metadata_edit is coalesced per field: renaming and re-dating inside one window are two edits.
    const field = type === 'meeting.metadata_edit' ? (details as { field?: unknown } | undefined)?.field : undefined;
    const key = `${userId}|${type}|${entityId}${typeof field === 'string' ? `|${field}` : ''}`;
    const dedupeMs = DEDUPE_WINDOW_MS[type];
    let stamp: number | undefined;
    if (dedupeMs) {
      const last = recentlySent.get(key);
      if (last !== undefined && Date.now() - last < dedupeMs) return undefined;
      stamp = Date.now();
      recentlySent.set(key, stamp);
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
        return undefined;
      }
      const timer = setTimeout(() => {
        const p = pending.get(key);
        if (!p) return;
        pending.delete(key);
        void commit(p.userId, p.event).then(() => scheduleFlush(p.userId));
      }, COALESCE_WINDOW_MS);
      pending.set(key, { userId, event, timer });
      return undefined;
    }

    const committed = commit(userId, event).then(() => scheduleFlush(userId));
    return () => {
      try {
        if (stamp !== undefined && recentlySent.get(key) === stamp) recentlySent.delete(key);
        void committed.then(() => removeFromOutbox(userId, [event.clientEventId]));
      } catch {
        // A retract that fails leaves the event queued: accepted, see above.
      }
    };
  } catch {
    // Reporting must never break the caller.
    return undefined;
  }
}

/** Test only. */
export function __resetAuditClient(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  recentlySent.clear();
  flushing.clear();
  rerun.clear();
  for (const t of flushTimers.values()) clearTimeout(t);
  flushTimers.clear();
  uninstall?.();
  uninstall = null;
  installed = false;
}

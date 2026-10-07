import { NextResponse } from 'next/server';
import { withAuthz } from '@/lib/authz/guard';
import { recordServerEvent, validateEvent } from '@/lib/audit/record';
import { noteDroppedEvents } from '@/lib/audit/dropped';
import type { AuditEventInput } from '@/lib/audit/events';
import {
  clampClientTime,
  clientEventsBody,
  hasUnknownEventType,
  isClientEventThrottled,
  markClientEventStored,
  MAX_CLIENT_BODY_BYTES,
  remainingClientEventsToday,
  takeClientEventBudget,
  THROTTLE_WINDOW_MS,
  THROTTLED_TYPES,
  UNKNOWN_EVENT_TYPE_BODY,
} from '@/lib/audit/client-ingest';

/**
 * Reads the body with a running byte count and gives up as soon as it passes `max`, so a
 * chunked body (no Content-Length) or a lying header cannot make the server buffer more
 * than `max` plus one chunk. null = too large.
 */
async function readBodyCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Receives events the browser reports about its own meetings (meeting.*). They are
// SELF-REPORTED: this route can only record that the signed-in user's client said
// so. Actor, IP, user agent and the server time come from the session and request,
// never from the body (the body schema is strict and has no such fields). Nothing
// from the request is echoed back.
export const POST = withAuthz('audit/client-events/POST', null, async (req, { session }) => {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_CLIENT_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  const text = await readBodyCapped(req, MAX_CLIENT_BODY_BYTES);
  if (text === null) return NextResponse.json({ error: 'Payload too large' }, { status: 413 });

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  // A type this server does not know is a rolling deploy (a newer browser, an older instance),
  // not a bad event: say so, and the browser keeps the event for later instead of dropping it.
  if (hasUnknownEventType(json)) return NextResponse.json(UNKNOWN_EVENT_TYPE_BODY, { status: 400 });
  const parsed = clientEventsBody.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  // A batch carries events, or at least the browser's report of what it lost.
  if (parsed.data.events.length === 0 && !parsed.data.droppedLocally) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const userId = session.user.id;
  const now = new Date();
  const inputs: AuditEventInput[] = [];
  for (const e of parsed.data.events) {
    const input = {
      type: e.type,
      source: 'client',
      actorUserId: userId,
      entityId: e.entityId,
      details: e.details,
      clientEventId: e.clientEventId,
      clientOccurredAt: clampClientTime(e.occurredAt, now),
    } as AuditEventInput;
    // All-or-nothing on shape: a batch with an invalid event is refused as a whole,
    // so the client can isolate the offender instead of silently losing it.
    if (!validateEvent(input).ok) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    inputs.push(input);
  }
  // Oldest first by (clamped) event time: the view throttle below compares event times, so a
  // browser that delivers hours of queued events in one request is judged in the order they happened.
  inputs.sort((a, b) => (a.clientOccurredAt as Date).getTime() - (b.clientOccurredAt as Date).getTime());

  const wait = takeClientEventBudget(userId, inputs.length);
  if (wait !== null) {
    // Refused as a whole and retried by the browser (Retry-After), so nothing is lost; counted
    // all the same, so a client that keeps hitting the limit is visible in the log.
    noteDroppedEvents(userId, 'rate_limit', inputs.length, req);
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': String(wait) } });
  }

  // Repeats of a view or playback within 60 s of EVENT time are dropped (acknowledged, so the
  // client outbox does not retry them). Judged against the last kept event of the same
  // (meeting, type): stored by an earlier request, or kept earlier in this sorted batch. Two
  // views four hours apart in one batch are both kept.
  const batchLast = new Map<string, number>();
  let throttled = 0;
  const candidates = inputs.filter((input) => {
    if (!THROTTLED_TYPES.has(input.type)) return true;
    const eventMs = (input.clientOccurredAt as Date).getTime();
    const key = `${input.entityId}|${input.type}`;
    const prev = batchLast.get(key);
    if ((prev !== undefined && Math.abs(eventMs - prev) < THROTTLE_WINDOW_MS) || isClientEventThrottled(userId, input.entityId as string, input.type, eventMs)) {
      throttled += 1;
      return false;
    }
    batchLast.set(key, eventMs);
    return true;
  });
  if (throttled > 0) noteDroppedEvents(userId, 'throttle', throttled, req);

  // Daily cap per user, from the database. Self-reported telemetry: when the count
  // cannot be read, store nothing and let the client retry (503), never guess.
  let remaining = 0;
  if (candidates.length > 0) {
    try {
      remaining = await remainingClientEventsToday(userId);
    } catch {
      console.warn('[audit] client event cap check failed');
      return NextResponse.json({ error: 'Audit unavailable' }, { status: 503 });
    }
  }

  let accepted = 0;
  let capped = 0;
  for (const input of candidates) {
    // Beyond the cap: dropped but acknowledged, so the outbox does not retry forever.
    // Counted and warned about (content-free), so it is never a silent loss.
    if (accepted >= remaining) {
      capped = candidates.length - accepted;
      console.warn(`[audit] client event cap reached, refused=${capped}`);
      noteDroppedEvents(userId, 'daily_cap', capped, req);
      break;
    }
    const result = await recordServerEvent(req, input);
    // Only a storage failure can drop a pre-validated event. Answer 503 so the
    // client keeps the batch; redelivery is idempotent on (actor, clientEventId).
    if (result.status === 'dropped') return NextResponse.json({ error: 'Audit unavailable' }, { status: 503 });
    markClientEventStored(userId, input.entityId as string, input.type, (input.clientOccurredAt as Date).getTime());
    accepted += 1;
  }

  // What the browser lost before it could deliver (self-reported). Exempt from the caps above: it
  // says that events are missing. Idempotent on (actor, clientEventId), so a retry does not double it.
  const lost = parsed.data.droppedLocally;
  if (lost) {
    const result = await recordServerEvent(req, {
      type: 'audit.events_dropped',
      source: 'client',
      actorUserId: userId,
      clientEventId: lost.clientEventId,
      clientOccurredAt: now,
      details: { reason: 'client_outbox', count: lost.count },
    });
    if (result.status === 'dropped') return NextResponse.json({ error: 'Audit unavailable' }, { status: 503 });
  }
  // `throttled`: repeats of a view within a minute of event time (by design); `capped`: refused by the daily cap.
  // Both are also counted in the log (audit.events_dropped).
  return NextResponse.json({
    accepted,
    ...(throttled > 0 ? { throttled } : {}),
    ...(capped > 0 ? { capped: true, refused: capped } : {}),
  });
});

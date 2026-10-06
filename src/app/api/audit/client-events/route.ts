import { NextResponse } from 'next/server';
import { withAuthz } from '@/lib/authz/guard';
import { recordServerEvent, validateEvent } from '@/lib/audit/record';
import type { AuditEventInput } from '@/lib/audit/events';
import {
  clampClientTime,
  clientEventsBody,
  isClientEventThrottled,
  markClientEventStored,
  MAX_CLIENT_BODY_BYTES,
  remainingClientEventsToday,
  takeClientEventBudget,
  THROTTLED_TYPES,
} from '@/lib/audit/client-ingest';

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
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_CLIENT_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const parsed = clientEventsBody.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

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

  const wait = takeClientEventBudget(userId, inputs.length);
  if (wait !== null) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': String(wait) } });
  }

  // Chatty types stored less than 60 s ago are dropped (acknowledged, so the client
  // outbox does not retry them). Checked against the stored marks plus earlier events
  // of this same batch, in order.
  const nowMs = Date.now();
  const batchSeen = new Set<string>();
  const candidates = inputs.filter((input) => {
    const key = `${input.entityId}|${input.type}`;
    if (batchSeen.has(key) || isClientEventThrottled(userId, input.entityId as string, input.type, nowMs)) return false;
    if (THROTTLED_TYPES.has(input.type)) batchSeen.add(key);
    return true;
  });

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
  let capped = false;
  for (const input of candidates) {
    // Beyond the cap: dropped but acknowledged, so the outbox does not retry forever.
    if (accepted >= remaining) {
      capped = true;
      break;
    }
    const result = await recordServerEvent(req, input);
    // Only a storage failure can drop a pre-validated event. Answer 503 so the
    // client keeps the batch; redelivery is idempotent on (actor, clientEventId).
    if (result.status === 'dropped') return NextResponse.json({ error: 'Audit unavailable' }, { status: 503 });
    markClientEventStored(userId, input.entityId as string, input.type);
    accepted += 1;
  }
  return NextResponse.json(capped ? { accepted, capped: true } : { accepted });
});

// The only writer of public.audit_events. Every event goes through the closed
// catalogue (events/index.ts) and the central content guard below, so the log
// holds activity METADATA only: opaque ids and short codes, never content.
//
// Two write modes:
//   recordEvent(event, { tx })  inserts ON that transaction and THROWS on any
//                               failure, so an admin change rolls back with its
//                               audit row (admin changes: access-admin, bootstrap,
//                               directory-match).
//   recordEvent(event)          best-effort: awaited, NEVER throws into the
//                               request. A failure drops the event and prints a
//                               content-free warning (event type + error code).
import { isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import { defaultRunner, type SqlQueryable } from '@/lib/authz/pg-runner';
import { db } from '@/lib/db';
import { directoryUsers, orgUnitMembers, users } from '@/lib/db/schema';
import { auditStdout, auditStoreIp } from './config';
import { eventDef, isEventType, type AuditEventInput, type AuditEventOf, type EventType } from './events';
import { CODE_RE, EVENT_OUTCOMES, EVENT_SOURCES, type EventOutcome, type EventSource } from './events/types';
import { cleanUserAgent, requestContext, type HeaderSource, type RequestContext } from './request-context';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ACTOR_ID_RE = /^[^\s\u0000-\u001f]{1,128}$/;
export const TABLE_RE = /^[A-Za-z0-9_."]{1,128}$/;

const MAX_DETAILS_BYTES = 2048;
const MAX_ARRAY_ENTRIES = 32;

/** Failure of an audit write. Message and `code` are fixed codes, never event content. */
export class AuditWriteError extends Error {
  constructor(readonly code: string) {
    super(`audit write failed: ${code}`);
    this.name = 'AuditWriteError';
  }
}

interface ValidatedEvent {
  type: EventType;
  source: EventSource;
  outcome: EventOutcome;
  actorUserId: string | null;
  entityType: string | null;
  entityId: string | null;
  secondaryEntityType: string | null;
  secondaryEntityId: string | null;
  details: Record<string, unknown>;
  clientEventId: string | null;
  clientOccurredAt: Date | null;
}

export type ValidationResult = { ok: true; value: ValidatedEvent } | { ok: false; code: string };

const isScalar = (v: unknown): v is string | number | boolean | null =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * The central content guard, applied to the PARSED details on top of the strict
 * per-event schema. Every string must be a whitespace-free short code (so prose
 * and transcript text cannot pass), arrays hold at most 32 scalars, there is no
 * nesting beyond one array level, and the serialised size is capped at 2 KB.
 * Returns an error code, or null when the details are acceptable.
 */
export function checkDetailsShape(details: unknown): string | null {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return 'details_not_object';
  let json: string;
  try {
    json = JSON.stringify(details);
  } catch {
    return 'details_not_serialisable';
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_DETAILS_BYTES) return 'details_too_large';

  const checkScalar = (v: unknown): string | null => {
    if (typeof v === 'string') return CODE_RE.test(v) ? null : 'details_string';
    if (typeof v === 'number') return Number.isFinite(v) ? null : 'details_number';
    return null;
  };

  for (const [key, value] of Object.entries(details)) {
    if (!CODE_RE.test(key)) return 'details_key';
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ENTRIES) return 'details_array_too_long';
      for (const item of value) {
        if (!isScalar(item)) return 'details_depth';
        const bad = checkScalar(item);
        if (bad) return bad;
      }
    } else if (isScalar(value)) {
      const bad = checkScalar(value);
      if (bad) return bad;
    } else {
      return 'details_depth';
    }
  }
  return null;
}

const asUuid = (v: string): string | null => (UUID_RE.test(v) ? v.toLowerCase() : null);

/** Pure validation of one event against the catalogue. Never throws. */
export function validateEvent(input: AuditEventInput): ValidationResult {
  if (input === null || typeof input !== 'object') return { ok: false, code: 'invalid_event' };
  const raw = input as AuditEventOf<EventType> & { type: unknown };
  if (!isEventType(raw.type)) return { ok: false, code: 'unknown_event_type' };
  const type = raw.type;
  const def = eventDef(type);

  const source = raw.source ?? def.sources[0];
  if (!(EVENT_SOURCES as readonly string[]).includes(source) || !def.sources.includes(source)) {
    return { ok: false, code: 'source_not_allowed' };
  }
  const outcome = raw.outcome ?? def.defaultOutcome ?? 'success';
  if (!(EVENT_OUTCOMES as readonly string[]).includes(outcome)) return { ok: false, code: 'invalid_outcome' };

  let actorUserId: string | null = null;
  if (raw.actorUserId != null) {
    if (typeof raw.actorUserId !== 'string' || !ACTOR_ID_RE.test(raw.actorUserId)) {
      return { ok: false, code: 'invalid_actor' };
    }
    actorUserId = raw.actorUserId;
  }
  // The unique (actor, client_event_id) index and the 'selvrapporteret' label both assume a known actor.
  if (source === 'client' && !actorUserId) return { ok: false, code: 'actor_required' };

  // Primary entity.
  let entityType: string | null = null;
  let entityId: string | null = null;
  if (def.entityType === null && !def.anyEntityType) {
    if (raw.entityType !== undefined || raw.entityId !== undefined) return { ok: false, code: 'entity_not_allowed' };
  } else {
    if (raw.entityType !== undefined) {
      const ok = def.anyEntityType ? ENTITY_TYPE_RE.test(raw.entityType) : raw.entityType === def.entityType;
      if (!ok) return { ok: false, code: 'invalid_entity_type' };
    }
    if (raw.entityId !== undefined) {
      entityId = asUuid(raw.entityId);
      if (!entityId) return { ok: false, code: 'invalid_entity_id' };
    } else if (def.entityIdRequired) {
      return { ok: false, code: 'entity_id_required' };
    }
    if (def.anyEntityType) {
      if (entityId && raw.entityType === undefined) return { ok: false, code: 'invalid_entity_type' };
      entityType = raw.entityType ?? null;
    } else {
      entityType = entityId ? def.entityType : null;
    }
  }

  // Secondary entity.
  let secondaryEntityType: string | null = null;
  let secondaryEntityId: string | null = null;
  if (raw.secondaryEntityId !== undefined || raw.secondaryEntityType !== undefined) {
    const allowed = def.secondaryEntityTypes;
    if (!allowed) return { ok: false, code: 'secondary_not_allowed' };
    if (raw.secondaryEntityId === undefined) return { ok: false, code: 'invalid_secondary_entity_id' };
    secondaryEntityId = asUuid(raw.secondaryEntityId);
    if (!secondaryEntityId) return { ok: false, code: 'invalid_secondary_entity_id' };
    // Omitted type: the first allowed one (so adding a second type never breaks existing callers).
    const t = raw.secondaryEntityType ?? allowed[0];
    if (!t || !allowed.includes(t)) return { ok: false, code: 'invalid_secondary_entity_type' };
    secondaryEntityType = t;
  }

  // Client delivery fields.
  let clientEventId: string | null = null;
  let clientOccurredAt: Date | null = null;
  if (raw.clientEventId !== undefined) {
    if (source !== 'client') return { ok: false, code: 'client_fields_not_allowed' };
    clientEventId = asUuid(raw.clientEventId);
    if (!clientEventId) return { ok: false, code: 'invalid_client_event_id' };
  }
  if (raw.clientOccurredAt !== undefined) {
    if (source !== 'client') return { ok: false, code: 'client_fields_not_allowed' };
    if (!(raw.clientOccurredAt instanceof Date) || Number.isNaN(raw.clientOccurredAt.getTime())) {
      return { ok: false, code: 'invalid_client_time' };
    }
    clientOccurredAt = raw.clientOccurredAt;
  }

  // Details: strict per-event schema first, then the central content guard on what would be stored.
  const parsed = def.details.safeParse((raw as { details?: unknown }).details ?? {});
  if (!parsed.success) return { ok: false, code: 'invalid_details' };
  // JSON round trip drops undefined keys so what is checked is exactly what is stored.
  const details = JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>;
  const shape = checkDetailsShape(details);
  if (shape) return { ok: false, code: shape };

  return {
    ok: true,
    value: {
      type,
      source,
      outcome,
      actorUserId,
      entityType,
      entityId,
      secondaryEntityType,
      secondaryEntityId,
      details,
      clientEventId,
      clientOccurredAt,
    },
  };
}

// ─── Actor snapshot ────────────────────────────────────────────────────────

interface ActorSnapshot {
  name: string | null;
  orgUnitUuid: string | null;
}

const NO_ACTOR: ActorSnapshot = { name: null, orgUnitUuid: null };

/**
 * Name and primary org unit of the actor, copied into the row so the log still
 * reads correctly after the user or unit changes and so scoped readers can be
 * limited by unit. Primary = the member row flagged is_primary, else the only
 * unit when there is exactly one, else NULL (then only global readers see it).
 */
async function actorSnapshot(userId: string | null): Promise<ActorSnapshot> {
  if (!userId) return NO_ACTOR;
  const found = await db
    .select({ name: users.name, directoryUuid: directoryUsers.uuid })
    .from(users)
    .leftJoin(directoryUsers, eq(directoryUsers.appUserId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  const row = found[0];
  if (!row) return NO_ACTOR;
  if (!row.directoryUuid) return { name: row.name, orgUnitUuid: null };

  const units = await db
    .select({ orgUnitUuid: orgUnitMembers.orgUnitUuid, isPrimary: orgUnitMembers.isPrimary })
    .from(orgUnitMembers)
    .where(eq(orgUnitMembers.directoryUserUuid, row.directoryUuid));
  const primary = units.filter((u) => u.isPrimary);
  const chosen = primary.length === 1 ? primary[0] : primary.length === 0 && units.length === 1 ? units[0] : null;
  return { name: row.name, orgUnitUuid: chosen ? chosen.orgUnitUuid : null };
}

// ─── Writing ───────────────────────────────────────────────────────────────

export interface RecordOptions {
  /**
   * Insert on this transaction handle and THROW on failure (admin changes).
   * Without it the write is best-effort and never throws.
   */
  tx?: SqlQueryable;
  /** ip / user agent / request id; recordServerEvent fills it from the request. */
  context?: Partial<RequestContext>;
  /** Test lane only: schema-qualified table, so the same code can run in a throwaway schema. */
  table?: string;
}

type RecordResult =
  | { status: 'stored' }
  /** A client event redelivered with a known (actor, client_event_id): nothing inserted. */
  | { status: 'duplicate' }
  | { status: 'dropped'; code: string };

function warnDropped(type: unknown, code: string): void {
  // Event type only when it is a catalogue name: anything else could carry content.
  const safeType = isEventType(type) ? type : 'unknown';
  console.warn(`[audit] event dropped type=${safeType} code=${code}`);
}

const typeOf = (event: unknown): unknown => (event as { type?: unknown } | null)?.type;

function errorCode(err: unknown): string {
  if (err instanceof AuditWriteError) return err.code;
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c) ? `db_error_${c}` : 'db_error';
}

function storedIp(ip: string | null | undefined): string | null {
  if (!auditStoreIp() || !ip || !isIP(ip)) return null;
  return ip;
}

const INSERT_COLUMNS = [
  'source',
  'event_type',
  'outcome',
  'actor_user_id',
  'actor_name',
  'actor_org_unit_uuid',
  'entity_type',
  'entity_id',
  'secondary_entity_type',
  'secondary_entity_id',
  'ip_address',
  'user_agent',
  'request_id',
  'details',
  'client_event_id',
  'client_occurred_at',
] as const;

async function write(input: AuditEventInput, opts: RecordOptions): Promise<RecordResult> {
  const result = validateEvent(input);
  if (!result.ok) throw new AuditWriteError(result.code);
  const e = result.value;

  const table = opts.table ?? 'public.audit_events';
  if (!TABLE_RE.test(table)) throw new AuditWriteError('invalid_table');

  let actor = NO_ACTOR;
  try {
    actor = await actorSnapshot(e.actorUserId);
  } catch (err) {
    // A snapshot is metadata: losing it must not lose the event. Without the unit, only global readers see the row (fail closed).
    console.warn(`[audit] actor snapshot unavailable code=${errorCode(err)}`);
  }

  const ctx = opts.context ?? {};
  const requestId = ctx.requestId && CODE_RE.test(ctx.requestId) ? ctx.requestId : null;
  const row: Record<(typeof INSERT_COLUMNS)[number], unknown> = {
    source: e.source,
    event_type: e.type,
    outcome: e.outcome,
    actor_user_id: e.actorUserId,
    actor_name: actor.name,
    actor_org_unit_uuid: actor.orgUnitUuid,
    entity_type: e.entityType,
    entity_id: e.entityId,
    secondary_entity_type: e.secondaryEntityType,
    secondary_entity_id: e.secondaryEntityId,
    ip_address: storedIp(ctx.ip),
    user_agent: cleanUserAgent(ctx.userAgent),
    request_id: requestId,
    details: JSON.stringify(e.details),
    client_event_id: e.clientEventId,
    client_occurred_at: e.clientOccurredAt,
  };

  const placeholders = INSERT_COLUMNS.map((c, i) => (c === 'details' ? `$${i + 1}::jsonb` : `$${i + 1}`));
  const q = opts.tx ?? defaultRunner();
  const res = await q.query<{ id: string; occurred_at: Date }>(
    `INSERT INTO ${table} (${INSERT_COLUMNS.join(', ')})
     VALUES (${placeholders.join(', ')})
     ON CONFLICT (actor_user_id, client_event_id) WHERE client_event_id IS NOT NULL DO NOTHING
     RETURNING id, occurred_at`,
    INSERT_COLUMNS.map((c) => row[c]),
  );
  const inserted = res.rows[0];
  if (!inserted) return { status: 'duplicate' };

  if (auditStdout()) {
    // One JSON line, the same validated fields as the row and nothing else.
    // With a tx the line is printed at insert time: the transaction may still roll back afterwards.
    const line = {
      id: String(inserted.id),
      occurred_at: inserted.occurred_at instanceof Date ? inserted.occurred_at.toISOString() : inserted.occurred_at,
      ...row,
      details: e.details,
      client_occurred_at: e.clientOccurredAt ? e.clientOccurredAt.toISOString() : null,
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
  return { status: 'stored' };
}

/**
 * Record one audit event.
 *
 *   await recordEvent({ type: 'export.download', actorUserId: userId, entityId: meetingId, details: { format: 'pdf' } });
 *
 * `details` is type-checked against the catalogue entry for `type`. Without
 * `opts.tx` this never throws: an invalid or unwritable event is dropped with a
 * content-free warning and the caller carries on. With `opts.tx` it inserts on
 * that transaction and throws AuditWriteError / the DB error so the surrounding
 * change rolls back.
 */
export async function recordEvent<T extends EventType>(input: AuditEventOf<T>, opts: RecordOptions = {}): Promise<RecordResult> {
  const event = input as AuditEventInput;
  // `tx` present but unusable (undefined / not a client) must fail closed: silently
  // falling back to the best-effort pool write would let an admin change commit without its audit row.
  if ('tx' in opts && typeof opts.tx?.query !== 'function') {
    const err = new AuditWriteError('invalid_tx');
    warnDropped(typeOf(event), err.code);
    throw err;
  }
  if (opts.tx) {
    try {
      return await write(event, opts);
    } catch (err) {
      warnDropped(typeOf(event), errorCode(err));
      throw err;
    }
  }
  try {
    return await write(event, opts);
  } catch (err) {
    const code = errorCode(err);
    warnDropped(typeOf(event), code);
    return { status: 'dropped', code };
  }
}

/**
 * recordEvent with ip / user agent / request id taken from the request. Best-effort unless `opts.tx` is given.
 * Reading the request is guarded too: unusable headers lose the request metadata, never the event or the request.
 */
export async function recordServerEvent<T extends EventType>(
  req: HeaderSource,
  input: AuditEventOf<T>,
  opts: Omit<RecordOptions, 'context'> = {},
): Promise<RecordResult> {
  let context: RequestContext | undefined;
  try {
    context = requestContext(req);
  } catch (err) {
    console.warn(`[audit] request context unavailable code=${errorCode(err)}`);
  }
  return recordEvent(input, { ...opts, ...(context ? { context } : {}) });
}

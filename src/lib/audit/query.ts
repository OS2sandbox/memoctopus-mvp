// Read side of public.audit_events: the admin viewer, the CSV export and the
// machine feed. All SQL is parameterised; the only interpolated text is the
// table name, which is a trusted constant (overridden only by the Postgres test
// lane, which runs in a throwaway schema, like scope.ts's orgUnitsTable).
//
// Visibility fails closed. A global audit.read sees every row. A scoped reader
// sees only rows whose actor_org_unit_uuid is in their covered units; a row with
// no unit snapshot (NULL) is invisible to them, because nobody can say whose it is.
import { orgUnitsInScope, type ScopeEnv } from '@/lib/authz/scope';
import type { Principal } from '@/lib/authz/types';
import { pool } from '@/lib/db';
import { EVENT_TYPES } from './events';
import type { EventOutcome, EventSource } from './events/types';
import { TABLE_RE, UUID_RE } from './record';

const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
export const MAX_FEED_SIZE = 1000;
/** Rows per round trip when exporting; the export itself is capped by the caller. */
const EXPORT_BATCH = 500;

const ID_RE = /^\d{1,18}$/;
const BIGINT_MAX = '9223372036854775807';

export interface AuditQueryEnv {
  query: (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  /** Schema-qualified, trusted constant. */
  table: string;
}

function defaultEnv(): AuditQueryEnv {
  return { query: (text, params) => pool.query(text, params), table: 'public.audit_events' };
}

function checkedTable(env: AuditQueryEnv): string {
  if (!TABLE_RE.test(env.table)) throw new RangeError('invalid table');
  return env.table;
}

type AuditScope = { all: true } | { all: false; orgUnitUuids: string[] };

/** Which actor org units the principal may read audit events for (audit.read). */
export async function auditScopeFor(principal: Principal, env?: ScopeEnv): Promise<AuditScope> {
  const covered = await orgUnitsInScope(principal, 'audit.read', env);
  return covered.all ? { all: true } : { all: false, orgUnitUuids: covered.uuids };
}

export interface AuditFilters {
  eventTypes?: string[];
  actorUserId?: string;
  /**
   * Name search: a case-insensitive substring of the actor's name snapshot (actor_name, as written
   * when the event happened), or an exact actor_user_id. It only narrows; it never widens scope.
   */
  q?: string;
  /** Matches the primary or the secondary entity. */
  entityId?: string;
  outcome?: EventOutcome;
  source?: EventSource;
  /** Inclusive bounds on occurred_at. */
  from?: Date;
  to?: Date;
}

/** One row as stored, camelCased. `id` is a string: bigint does not fit a JS number in general. */
export interface AuditEventRow {
  id: string;
  occurredAt: Date;
  source: EventSource;
  eventType: string;
  outcome: EventOutcome;
  actorUserId: string | null;
  actorName: string | null;
  actorOrgUnitUuid: string | null;
  entityType: string | null;
  entityId: string | null;
  secondaryEntityType: string | null;
  secondaryEntityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  details: Record<string, unknown>;
  clientOccurredAt: Date | null;
}

// An explicit column list (never SELECT *): a column added later does not
// silently start flowing to the viewer or the feed.
const COLUMNS = `id, occurred_at, source, event_type, outcome, actor_user_id, actor_name, actor_org_unit_uuid,
  entity_type, entity_id, secondary_entity_type, secondary_entity_id, ip_address, user_agent, request_id,
  details, client_occurred_at`;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const date = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));

function mapRow(r: Record<string, unknown>): AuditEventRow {
  return {
    id: String(r.id),
    occurredAt: date(r.occurred_at) as Date,
    source: r.source as EventSource,
    eventType: String(r.event_type),
    outcome: r.outcome as EventOutcome,
    actorUserId: str(r.actor_user_id),
    actorName: str(r.actor_name),
    actorOrgUnitUuid: str(r.actor_org_unit_uuid),
    entityType: str(r.entity_type),
    entityId: str(r.entity_id),
    secondaryEntityType: str(r.secondary_entity_type),
    secondaryEntityId: str(r.secondary_entity_id),
    ipAddress: str(r.ip_address),
    userAgent: str(r.user_agent),
    requestId: str(r.request_id),
    details: (r.details ?? {}) as Record<string, unknown>,
    clientOccurredAt: date(r.client_occurred_at),
  };
}

interface ListOptions {
  filters?: AuditFilters;
  /** The `nextCursor` of the previous page: rows with a lower id are returned. */
  cursor?: string;
  limit?: number;
  scope: AuditScope;
}

interface AuditPage {
  rows: AuditEventRow[];
  /** Pass as `cursor` for the next page; null when this was the last one. */
  nextCursor: string | null;
}

const EMPTY: AuditPage = { rows: [], nextCursor: null };

function clampLimit(limit: number | undefined, max: number): number {
  if (limit === undefined) return Math.min(DEFAULT_PAGE_SIZE, max);
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  return Math.min(limit, max);
}

/** LIKE pattern for a literal substring: backslash, % and _ are escaped so they match themselves. */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

/** The WHERE conditions (and their parameters) shared by the viewer and the export. */
function buildWhere(
  filters: AuditFilters,
  scope: AuditScope,
  cursor: string | undefined,
  params: unknown[],
): string[] | null {
  const where: string[] = [];
  const add = (sql: (p: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };

  if (!scope.all) {
    const units = scope.orgUnitUuids.filter((u) => UUID_RE.test(u));
    if (units.length === 0) return null; // a scoped reader with no units sees nothing
    add((p) => `actor_org_unit_uuid = ANY(${p}::uuid[])`, units);
  }
  if (cursor !== undefined) {
    if (!ID_RE.test(cursor)) throw new RangeError('invalid cursor');
    add((p) => `id < ${p}::bigint`, cursor);
  }
  if (filters.eventTypes && filters.eventTypes.length > 0) add((p) => `event_type = ANY(${p}::text[])`, filters.eventTypes);
  if (filters.actorUserId !== undefined) add((p) => `actor_user_id = ${p}`, filters.actorUserId);
  if (filters.entityId !== undefined) {
    if (!UUID_RE.test(filters.entityId)) throw new RangeError('invalid entity id');
    add((p) => `(entity_id = ${p} OR secondary_entity_id = ${p})`, filters.entityId.toLowerCase());
  }
  if (filters.outcome !== undefined) add((p) => `outcome = ${p}`, filters.outcome);
  if (filters.source !== undefined) add((p) => `source = ${p}`, filters.source);
  if (filters.from) add((p) => `occurred_at >= ${p}`, filters.from);
  if (filters.to) add((p) => `occurred_at <= ${p}`, filters.to);
  if (filters.q !== undefined) {
    params.push(likeContains(filters.q), filters.q);
    where.push(`(actor_name ILIKE $${params.length - 1} OR actor_user_id = $${params.length})`);
  }
  // Rows of a type this build does not know (written by a newer or older release) are NOT hidden:
  // the viewer and the export show them as "Ukendt hændelsestype (<kode>)", so a rolling deploy
  // or a rollback never makes log rows vanish. The one exception is the removed, unreleased
  // access.* events, which stay hidden (they stay in the table and in the SIEM feed, which
  // does not use this filter).
  add((p) => `(event_type = ANY(${p}::text[]) OR event_type NOT LIKE 'access.%')`, EVENT_TYPES);
  return where;
}

async function selectPage(
  opts: ListOptions,
  limit: number,
  env: AuditQueryEnv,
): Promise<AuditPage> {
  const table = checkedTable(env);
  const params: unknown[] = [];
  const where = buildWhere(opts.filters ?? {}, opts.scope, opts.cursor, params);
  if (where === null) return EMPTY;
  params.push(limit + 1);
  const { rows } = await env.query(
    `SELECT ${COLUMNS} FROM ${table}
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit).map(mapRow);
  const hasMore = rows.length > limit;
  return { rows: page, nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id : null };
}

/** Newest first, keyset-paginated on id (stable while new rows arrive). `limit` is capped at 100. */
export async function listAuditEvents(opts: ListOptions, env: AuditQueryEnv = defaultEnv()): Promise<AuditPage> {
  return selectPage(opts, clampLimit(opts.limit, MAX_PAGE_SIZE), env);
}

/**
 * Newest first, up to `maxRows`, fetched in batches. Used by the CSV export.
 * `truncated` is true when more rows matched than the cap allowed.
 */
export async function collectAuditEvents(
  opts: Omit<ListOptions, 'limit' | 'cursor'> & { maxRows: number },
  env: AuditQueryEnv = defaultEnv(),
): Promise<{ rows: AuditEventRow[]; truncated: boolean }> {
  const rows: AuditEventRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const room = opts.maxRows - rows.length;
    if (room <= 0) {
      // Cap reached exactly: is there anything left?
      const more = await selectPage({ ...opts, cursor }, 1, env);
      return { rows, truncated: more.rows.length > 0 };
    }
    const page = await selectPage({ ...opts, cursor }, Math.min(EXPORT_BATCH, room), env);
    rows.push(...page.rows);
    if (!page.nextCursor) return { rows, truncated: false };
    cursor = page.nextCursor;
  }
}

// ─── Machine feed ──────────────────────────────────────────────────────────

/**
 * bigserial ids are handed out at INSERT but become visible at COMMIT, so a
 * reader that remembers "the highest id I saw" can skip a row that commits late.
 * The feed therefore only serves the contiguous run of rows BELOW the lowest id
 * that is still younger than the delay: everything it returns is older than
 * `delaySeconds`, and a younger row (which may still be uncommitted neighbours'
 * company) holds back every later id too. occurred_at is the transaction start,
 * so a transaction that stays open longer than the delay can still be missed;
 * audit writes are single statements or short admin transactions.
 */
const FEED_BOUND = `COALESCE(
  (SELECT min(id) FROM %TABLE% WHERE occurred_at >= now() - make_interval(secs => $1::double precision)),
  ${BIGINT_MAX}::bigint)`;

function feedBound(table: string): string {
  return FEED_BOUND.replace('%TABLE%', table);
}

/** Highest id the feed may serve right now (0 when there is none). */
export async function getFeedHead(delaySeconds: number, env: AuditQueryEnv = defaultEnv()): Promise<number> {
  const table = checkedTable(env);
  const { rows } = await env.query(`SELECT max(id) AS head FROM ${table} WHERE id < ${feedBound(table)}`, [
    Math.max(0, delaySeconds),
  ]);
  const head = rows[0]?.head;
  return head === null || head === undefined ? 0 : Number(head);
}

interface FeedOptions {
  /** Rows with id > offset are returned. */
  offset: number;
  size: number;
  delaySeconds: number;
}

/** Rows with offset < id <= head, oldest first. `next` is the offset to ask for next time. */
export async function getFeedPage(
  opts: FeedOptions,
  env: AuditQueryEnv = defaultEnv(),
): Promise<{ rows: AuditEventRow[]; next: number }> {
  const table = checkedTable(env);
  if (!Number.isSafeInteger(opts.offset) || opts.offset < 0) throw new RangeError('invalid offset');
  if (!Number.isSafeInteger(opts.size) || opts.size < 1) throw new RangeError('invalid size');
  const size = Math.min(opts.size, MAX_FEED_SIZE);
  const { rows } = await env.query(
    `SELECT ${COLUMNS} FROM ${table}
      WHERE id > $2::bigint AND id < ${feedBound(table)}
      ORDER BY id ASC
      LIMIT $3`,
    [Math.max(0, opts.delaySeconds), String(opts.offset), size],
  );
  const mapped = rows.map(mapRow);
  const last = mapped[mapped.length - 1];
  return { rows: mapped, next: last ? Number(last.id) : opts.offset };
}

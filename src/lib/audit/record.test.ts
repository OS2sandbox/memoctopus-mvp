import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A thenable query-builder stand-in: every chain method returns itself and
// awaiting it yields the next queued result set (users join, then org units).
const h = vi.hoisted(() => ({
  results: [] as unknown[],
  dbError: null as unknown,
  selects: 0,
  poolQuery: vi.fn(),
}));
vi.mock('@/lib/db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'leftJoin', 'where', 'limit']) c[m] = () => c;
    c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      if (h.dbError) return Promise.reject(h.dbError).then(resolve, reject);
      return Promise.resolve(h.results.shift() ?? []).then(resolve, reject);
    };
    return c;
  };
  return {
    db: { select: () => (h.selects++, chain()) },
    pool: { query: h.poolQuery, connect: vi.fn() },
  };
});

import { AuditWriteError, checkDetailsShape, recordEvent, recordServerEvent, validateEvent } from './record';
import type { AuditEventInput } from './events';

const UUID = '11111111-2222-4333-8444-555555555555';
const UNIT = '99999999-2222-4333-8444-555555555555';
const DIR = 'dddddddd-2222-4333-8444-555555555555';

const STORED = { rows: [{ id: '7', occurred_at: new Date('2026-10-05T10:00:00.000Z') }], rowCount: 1 };
const DUPLICATE = { rows: [], rowCount: 0 };

function fakeTx(result: unknown = STORED) {
  return { query: vi.fn(async (..._a: unknown[]) => result as never) };
}

const exportEvent = (over: Record<string, unknown> = {}) =>
  ({ type: 'export.download', actorUserId: 'user-1', entityId: UUID, details: { format: 'pdf' }, ...over }) as AuditEventInput;

/** Insert parameters by column name, from the recorded query call. */
function params(tx: { query: { mock: { calls: unknown[][] } } }, call = 0): Record<string, unknown> {
  const sql = String(tx.query.mock.calls[call][0]);
  const cols = /\(([^)]+)\)\s*VALUES/.exec(sql)![1].split(',').map((c) => c.trim());
  const values = tx.query.mock.calls[call][1] as unknown[];
  return Object.fromEntries(cols.map((c, i) => [c, values[i]]));
}

let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let errLog: ReturnType<typeof vi.spyOn>;
let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.results = [];
  h.dbError = null;
  h.selects = 0;
  h.poolQuery.mockReset();
  h.poolQuery.mockResolvedValue(STORED);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  errLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('recordEvent: tx variant (throws)', () => {
  it('inserts on the given transaction, not on the pool', async () => {
    const tx = fakeTx();
    const res = await recordEvent(exportEvent(), { tx });
    expect(res).toEqual({ status: 'stored' });
    expect(tx.query).toHaveBeenCalledOnce();
    expect(h.poolQuery).not.toHaveBeenCalled();
    expect(String(tx.query.mock.calls[0][0])).toContain('INSERT INTO public.audit_events');
    expect(params(tx)).toMatchObject({
      source: 'server',
      event_type: 'export.download',
      outcome: 'success',
      actor_user_id: 'user-1',
      entity_type: 'meeting',
      entity_id: UUID,
      details: JSON.stringify({ format: 'pdf' }),
    });
  });

  it('throws AuditWriteError for an invalid event and writes nothing', async () => {
    const tx = fakeTx();
    await expect(recordEvent(exportEvent({ details: { format: 'exe' } }), { tx })).rejects.toMatchObject({
      name: 'AuditWriteError',
      code: 'invalid_details',
    });
    expect(tx.query).not.toHaveBeenCalled();
  });

  it('propagates a database error so the surrounding change rolls back', async () => {
    const boom = Object.assign(new Error('relation "audit_events" does not exist'), { code: '42P01' });
    const tx = { query: vi.fn(async () => { throw boom; }) };
    await expect(recordEvent(exportEvent(), { tx })).rejects.toBe(boom);
  });
});

describe('recordEvent: best-effort variant (never throws)', () => {
  it('writes on the pool and reports stored', async () => {
    expect(await recordEvent(exportEvent())).toEqual({ status: 'stored' });
    expect(h.poolQuery).toHaveBeenCalledOnce();
  });

  it('resolves dropped (does not throw) for an invalid event', async () => {
    const res = await recordEvent(exportEvent({ details: { format: 'exe' } }));
    expect(res).toEqual({ status: 'dropped', code: 'invalid_details' });
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  it('resolves dropped when the database fails, with only a code in the result', async () => {
    h.poolQuery.mockRejectedValue(Object.assign(new Error('password authentication failed for user "x"'), { code: '28P01' }));
    const res = await recordEvent(exportEvent());
    expect(res).toEqual({ status: 'dropped', code: 'db_error_28P01' });
  });

  it('resolves dropped for an unknown event type and for garbage input', async () => {
    expect((await recordEvent({ type: 'meeting.title_changed' } as never)).status).toBe('dropped');
    expect((await recordEvent(null as never)).status).toBe('dropped');
    expect((await recordEvent({} as never)).status).toBe('dropped');
  });
});

describe('drop warnings are content free', () => {
  const LEAKS = ['Vi skal tale om sagen om Jensens barn.', 'jens@example.dk', 'https://teams.microsoft.com/x', 'Møde referat.docx'];

  it('never prints the offending value, whichever field carried it', async () => {
    for (const leak of LEAKS) {
      await recordEvent(exportEvent({ details: { format: leak } }));
      await recordEvent(exportEvent({ details: { format: 'pdf', title: leak } }));
      await recordEvent(exportEvent({ entityId: leak }));
      await recordEvent(exportEvent({ actorUserId: leak }));
      await recordEvent(exportEvent({ entityType: leak }));
      await recordEvent({ type: leak } as never);
      await recordEvent(exportEvent(), { context: { requestId: leak } }); // unusable id: stored as null, not printed
      h.poolQuery.mockRejectedValueOnce(new Error(`insert failed for ${leak}`));
      await recordEvent(exportEvent());
    }
    const printed = JSON.stringify([...warn.mock.calls, ...log.mock.calls, ...errLog.mock.calls, ...stdout.mock.calls]);
    for (const leak of LEAKS) expect(printed).not.toContain(leak);
    expect(warn).toHaveBeenCalled();
  });

  it('logs the catalogue event type and a code, and "unknown" for anything else', async () => {
    await recordEvent(exportEvent({ details: { format: 'exe' } }));
    await recordEvent({ type: 'Vi skal tale om sagen' } as never);
    expect(warn.mock.calls[0][0]).toBe('[audit] event dropped type=export.download code=invalid_details');
    expect(warn.mock.calls[1][0]).toBe('[audit] event dropped type=unknown code=unknown_event_type');
  });

  it('a thrown AuditWriteError carries only a code', () => {
    const e = new AuditWriteError('invalid_details');
    expect(e.message).toBe('audit write failed: invalid_details');
  });
});

describe('id validation', () => {
  it('requires entity ids to be uuids and normalises case', () => {
    expect(validateEvent(exportEvent({ entityId: 'meeting-1' }))).toEqual({ ok: false, code: 'invalid_entity_id' });
    expect(validateEvent(exportEvent({ entityId: `${UUID} ` }))).toEqual({ ok: false, code: 'invalid_entity_id' });
    expect(validateEvent(exportEvent({ entityId: '../../etc/passwd' }))).toEqual({ ok: false, code: 'invalid_entity_id' });
    const ok = validateEvent(exportEvent({ entityId: UUID.toUpperCase() }));
    expect(ok.ok && ok.value.entityId).toBe(UUID);
  });

  it('enforces entityIdRequired per catalogue entry', () => {
    expect(validateEvent({ type: 'meeting.delete', source: 'client', actorUserId: 'u', details: {} } as never)).toEqual({
      ok: false,
      code: 'entity_id_required',
    });
    expect(validateEvent({ type: 'template.delete', actorUserId: 'u' } as never)).toEqual({ ok: false, code: 'entity_id_required' });
    // export.download does not require one.
    expect(validateEvent({ type: 'export.download', actorUserId: 'u', details: { format: 'md' } } as never).ok).toBe(true);
  });

  it('rejects an entity on events that have none, and a wrong entity type', () => {
    expect(validateEvent({ type: 'auth.logout', actorUserId: 'u', entityId: UUID } as never)).toEqual({ ok: false, code: 'entity_not_allowed' });
    expect(validateEvent(exportEvent({ entityType: 'user' }))).toEqual({ ok: false, code: 'invalid_entity_type' });
  });

  it('validates the secondary entity and its type', () => {
    const base = { type: 'access.role_assign', actorUserId: 'u', entityId: UUID, details: { roleKey: 'tt-logleser' } };
    expect(validateEvent({ ...base, secondaryEntityId: 'x1' } as never)).toEqual({ ok: false, code: 'invalid_secondary_entity_id' });
    expect(validateEvent({ ...base, secondaryEntityType: 'org_unit', secondaryEntityId: DIR } as never)).toEqual({
      ok: false,
      code: 'invalid_secondary_entity_type',
    });
    const ok = validateEvent({ ...base, secondaryEntityId: DIR } as never);
    expect(ok.ok && [ok.value.secondaryEntityType, ok.value.secondaryEntityId]).toEqual(['directory_user', DIR]);
    // With several allowed types an omitted type means the first one.
    const multi = validateEvent({
      type: 'minutes.generate',
      actorUserId: 'u',
      secondaryEntityId: DIR,
      details: { templateSource: 'personal', durationMs: 1, segmentCount: 1 },
    } as never);
    expect(multi.ok && multi.value.secondaryEntityType).toBe('template');
    // An event without a secondary entity refuses one.
    expect(validateEvent({ ...exportEvent(), secondaryEntityId: DIR } as never)).toEqual({ ok: false, code: 'secondary_not_allowed' });
  });

  it('lets authz.denied pick an entity type code but still requires a uuid id', () => {
    const base = { type: 'authz.denied', actorUserId: 'u', details: { required: 'access.manage', reason: 'out_of_scope' } };
    expect(validateEvent({ ...base, entityType: 'org_unit', entityId: UNIT } as never).ok).toBe(true);
    expect(validateEvent({ ...base, entityType: 'Org Unit', entityId: UNIT } as never)).toEqual({ ok: false, code: 'invalid_entity_type' });
    expect(validateEvent({ ...base, entityType: 'org_unit', entityId: 'u1' } as never)).toEqual({ ok: false, code: 'invalid_entity_id' });
    expect(validateEvent({ ...base, entityId: UNIT } as never)).toEqual({ ok: false, code: 'invalid_entity_type' });
    const res = validateEvent(base as never);
    expect(res.ok && res.value.outcome).toBe('denied');
  });

  it('rejects a non-uuid client event id', () => {
    expect(validateEvent(clientEvent({ clientEventId: 'abc' }))).toEqual({ ok: false, code: 'invalid_client_event_id' });
  });
});

function clientEvent(over: Record<string, unknown> = {}): AuditEventInput {
  return {
    type: 'meeting.create',
    source: 'client',
    actorUserId: 'user-1',
    entityId: UUID,
    details: { origin: 'live' },
    ...over,
  } as AuditEventInput;
}

describe('source rules', () => {
  it('defaults the source to the first allowed one and rejects the others', () => {
    const d = validateEvent(exportEvent());
    expect(d.ok && d.value.source).toBe('server');
    expect(validateEvent(exportEvent({ source: 'client' }))).toEqual({ ok: false, code: 'source_not_allowed' });
    expect(validateEvent(exportEvent({ source: 'bogus' }))).toEqual({ ok: false, code: 'source_not_allowed' });
    // Meeting events are client-only: a server cannot claim to have observed them.
    expect(validateEvent(clientEvent({ source: 'server' }))).toEqual({ ok: false, code: 'source_not_allowed' });
  });

  it('requires an actor for client events and allows client delivery fields only there', () => {
    expect(validateEvent(clientEvent({ actorUserId: null }))).toEqual({ ok: false, code: 'actor_required' });
    expect(validateEvent(exportEvent({ clientEventId: UUID }))).toEqual({ ok: false, code: 'client_fields_not_allowed' });
    expect(validateEvent(exportEvent({ clientOccurredAt: new Date() }))).toEqual({ ok: false, code: 'client_fields_not_allowed' });
    expect(validateEvent(clientEvent({ clientEventId: UUID, clientOccurredAt: new Date() })).ok).toBe(true);
    expect(validateEvent(clientEvent({ clientOccurredAt: new Date('nope') }))).toEqual({ ok: false, code: 'invalid_client_time' });
  });

  it('reports a redelivered client event as duplicate and writes the dedupe clause', async () => {
    const tx = fakeTx(DUPLICATE);
    const res = await recordEvent(clientEvent({ clientEventId: UUID }), { tx });
    expect(res).toEqual({ status: 'duplicate' });
    expect(String(tx.query.mock.calls[0][0])).toContain(
      'ON CONFLICT (actor_user_id, client_event_id) WHERE client_event_id IS NOT NULL DO NOTHING',
    );
    expect(params(tx)).toMatchObject({ source: 'client', client_event_id: UUID });
  });

  it('uses the event type default outcome and lets the caller override it', () => {
    const failed = validateEvent({ type: 'auth.login_failed', details: { reason: 'invalid_credentials' } } as never);
    expect(failed.ok && failed.value.outcome).toBe('error');
    const denied = validateEvent({ type: 'auth.login_failed', outcome: 'denied', details: { reason: 'rate_limited' } } as never);
    expect(denied.ok && denied.value.outcome).toBe('denied');
    expect(validateEvent(exportEvent({ outcome: 'maybe' }))).toEqual({ ok: false, code: 'invalid_outcome' });
  });
});

describe('details shape rule', () => {
  it('accepts codes, numbers, booleans, null and arrays of scalars', () => {
    expect(checkDetailsShape({ a: 'b_c.d:e-f', n: 3.5, t: true, z: null, list: ['x', 'y', 2] })).toBeNull();
  });
  it('rejects prose, long strings, symbols and whitespace', () => {
    expect(checkDetailsShape({ a: 'Vi skal tale om sagen om Jensens barn.' })).toBe('details_string');
    expect(checkDetailsShape({ a: 'a'.repeat(65) })).toBe('details_string');
    expect(checkDetailsShape({ a: 'a b' })).toBe('details_string');
    expect(checkDetailsShape({ a: '' })).toBe('details_string');
    expect(checkDetailsShape({ a: 'jens@example.dk' })).toBe('details_string');
    expect(checkDetailsShape({ list: ['ok', 'not ok'] })).toBe('details_string');
  });
  it('rejects nesting beyond one array level and arrays over 32 entries', () => {
    expect(checkDetailsShape({ o: { x: 1 } })).toBe('details_depth');
    expect(checkDetailsShape({ list: [['x']] })).toBe('details_depth');
    expect(checkDetailsShape({ list: [{ x: 1 }] })).toBe('details_depth');
    expect(checkDetailsShape({ list: Array.from({ length: 32 }, () => 'a') })).toBeNull();
    expect(checkDetailsShape({ list: Array.from({ length: 33 }, () => 'a') })).toBe('details_array_too_long');
  });
  it('caps the serialised size at 2 KB', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'v'.repeat(60)]));
    expect(checkDetailsShape(many)).toBe('details_too_large');
    expect(checkDetailsShape({ k: 'v'.repeat(60) })).toBeNull();
  });
  it('rejects non-objects, non-finite numbers and unsafe keys', () => {
    expect(checkDetailsShape(null)).toBe('details_not_object');
    expect(checkDetailsShape([])).toBe('details_not_object');
    expect(checkDetailsShape('x')).toBe('details_not_object');
    expect(checkDetailsShape({ a: Infinity })).toBe('details_number');
    expect(checkDetailsShape({ 'a b': 1 })).toBe('details_key');
  });
});

describe('actor snapshot', () => {
  const lookup = (user: unknown[], units?: unknown[]) => {
    h.results = units === undefined ? [user] : [user, units];
  };

  it('stores the name and the unit flagged primary', async () => {
    lookup([{ name: 'Mette Hansen', directoryUuid: DIR }], [
      { orgUnitUuid: 'aaaaaaaa-0000-4000-8000-000000000001', isPrimary: false },
      { orgUnitUuid: UNIT, isPrimary: true },
    ]);
    const tx = fakeTx();
    await recordEvent(exportEvent(), { tx });
    expect(params(tx)).toMatchObject({ actor_name: 'Mette Hansen', actor_org_unit_uuid: UNIT });
  });

  it('uses the only unit when none is flagged primary', async () => {
    lookup([{ name: 'A', directoryUuid: DIR }], [{ orgUnitUuid: UNIT, isPrimary: false }]);
    const tx = fakeTx();
    await recordEvent(exportEvent(), { tx });
    expect(params(tx).actor_org_unit_uuid).toBe(UNIT);
  });

  it('leaves the unit NULL when several units and no single primary (global readers only)', async () => {
    const two = [
      { orgUnitUuid: UNIT, isPrimary: false },
      { orgUnitUuid: 'aaaaaaaa-0000-4000-8000-000000000001', isPrimary: false },
    ];
    lookup([{ name: 'A', directoryUuid: DIR }], two);
    let tx = fakeTx();
    await recordEvent(exportEvent(), { tx });
    expect(params(tx).actor_org_unit_uuid).toBeNull();

    lookup([{ name: 'A', directoryUuid: DIR }], two.map((u) => ({ ...u, isPrimary: true })));
    tx = fakeTx();
    await recordEvent(exportEvent(), { tx });
    expect(params(tx).actor_org_unit_uuid).toBeNull();
  });

  it('keeps the name when the user has no directory row, and nothing when the user is gone', async () => {
    lookup([{ name: 'Solo', directoryUuid: null }]);
    let tx = fakeTx();
    await recordEvent(exportEvent(), { tx });
    expect(params(tx)).toMatchObject({ actor_name: 'Solo', actor_org_unit_uuid: null });
    expect(h.selects).toBe(1);

    lookup([]);
    tx = fakeTx();
    await recordEvent(exportEvent(), { tx });
    expect(params(tx)).toMatchObject({ actor_user_id: 'user-1', actor_name: null, actor_org_unit_uuid: null });
  });

  it('does not look anything up without an actor', async () => {
    const tx = fakeTx();
    await recordEvent({ type: 'audit.prune', source: 'system', details: { deletedCount: 1, olderThanDays: 30 } }, { tx });
    expect(h.selects).toBe(0);
    expect(params(tx)).toMatchObject({ actor_user_id: null, actor_name: null, source: 'system' });
  });

  it('still stores the event, without a snapshot, when the lookup fails', async () => {
    h.dbError = Object.assign(new Error('connection to "secret-host" refused'), { code: 'ECONNREFUSED' });
    const tx = fakeTx();
    const res = await recordEvent(exportEvent(), { tx });
    expect(res).toEqual({ status: 'stored' });
    expect(params(tx)).toMatchObject({ actor_name: null, actor_org_unit_uuid: null });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-host');
  });
});

describe('request context columns', () => {
  const ctx = { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (X11)', requestId: 'req-1' };

  it('stores ip, user agent and request id from the context', async () => {
    const tx = fakeTx();
    await recordEvent(exportEvent(), { tx, context: ctx });
    expect(params(tx)).toMatchObject({ ip_address: '203.0.113.9', user_agent: 'Mozilla/5.0 (X11)', request_id: 'req-1' });
  });

  it('AUDIT_STORE_IP=false stores no ip (but keeps the rest)', async () => {
    vi.stubEnv('AUDIT_STORE_IP', 'false');
    const tx = fakeTx();
    await recordEvent(exportEvent(), { tx, context: ctx });
    expect(params(tx)).toMatchObject({ ip_address: null, user_agent: 'Mozilla/5.0 (X11)', request_id: 'req-1' });
  });

  it('stores only real ip addresses, truncates the user agent to 255 and drops unsafe request ids', async () => {
    const tx = fakeTx();
    await recordEvent(exportEvent(), {
      tx,
      context: { ip: 'not an ip', userAgent: `${'x'.repeat(300)}\n`, requestId: 'has spaces' },
    });
    const p = params(tx);
    expect(p.ip_address).toBeNull();
    expect(String(p.user_agent)).toHaveLength(255);
    expect(p.request_id).toBeNull();
  });

  it('recordServerEvent takes them from the request headers', async () => {
    const headers = new Headers({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1', 'user-agent': 'UA/1', 'x-request-id': 'a1b2c3d4e5f60718293a4b5c6d7e8f90' });
    const tx = fakeTx();
    await recordServerEvent({ headers }, exportEvent(), { tx });
    expect(params(tx)).toMatchObject({ ip_address: '198.51.100.7', user_agent: 'UA/1', request_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' });
  });
});

describe('stdout mirror', () => {
  const lines = () => stdout.mock.calls.map((c: unknown[]) => String(c[0]));

  it('prints nothing unless AUDIT_STDOUT=true', async () => {
    await recordEvent(exportEvent(), { tx: fakeTx() });
    expect(stdout).not.toHaveBeenCalled();
  });

  it('prints one JSON line with the validated fields and nothing extra', async () => {
    vi.stubEnv('AUDIT_STDOUT', 'true');
    await recordEvent(exportEvent(), { tx: fakeTx(), context: { ip: '203.0.113.9', userAgent: 'UA', requestId: 'r1' } });
    expect(lines()).toHaveLength(1);
    const out = lines()[0];
    expect(out.endsWith('\n')).toBe(true);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out)).toEqual({
      id: '7',
      occurred_at: '2026-10-05T10:00:00.000Z',
      source: 'server',
      event_type: 'export.download',
      outcome: 'success',
      actor_user_id: 'user-1',
      actor_name: null,
      actor_org_unit_uuid: null,
      entity_type: 'meeting',
      entity_id: UUID,
      secondary_entity_type: null,
      secondary_entity_id: null,
      ip_address: '203.0.113.9',
      user_agent: 'UA',
      request_id: 'r1',
      details: { format: 'pdf' },
      client_event_id: null,
      client_occurred_at: null,
    });
  });

  it('honours AUDIT_STORE_IP=false in the mirror too', async () => {
    vi.stubEnv('AUDIT_STDOUT', 'true');
    vi.stubEnv('AUDIT_STORE_IP', 'false');
    await recordEvent(exportEvent(), { tx: fakeTx(), context: { ip: '203.0.113.9' } });
    expect(JSON.parse(lines()[0]).ip_address).toBeNull();
  });

  it('does not print dropped events or duplicates', async () => {
    vi.stubEnv('AUDIT_STDOUT', 'true');
    await recordEvent(exportEvent({ details: { format: 'exe' } }));
    await recordEvent(clientEvent({ clientEventId: UUID }), { tx: fakeTx(DUPLICATE) });
    expect(stdout).not.toHaveBeenCalled();
  });
});

// Compile-time checks (tsc --noEmit): details are typed per event type.
export function typeChecks() {
  void recordEvent({ type: 'export.download', details: { format: 'pdf' } });
  void recordEvent({ type: 'auth.logout' });
  // @ts-expect-error format must be one of pdf | docx | md
  void recordEvent({ type: 'export.download', details: { format: 'exe' } });
  // @ts-expect-error unknown event type
  void recordEvent({ type: 'meeting.title_changed' });
  // @ts-expect-error unknown detail key
  void recordEvent({ type: 'export.download', details: { format: 'pdf', title: 'x' } });
  // @ts-expect-error required details missing
  void recordEvent({ type: 'minutes.generate' });
}

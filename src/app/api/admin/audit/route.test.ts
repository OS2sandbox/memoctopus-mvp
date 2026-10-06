import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/db', () => ({ pool: { query: vi.fn() }, db: {} }));
vi.mock('@/lib/audit/query', async (orig) => ({
  ...(await orig<typeof import('@/lib/audit/query')>()),
  auditScopeFor: vi.fn(),
  listAuditEvents: vi.fn(),
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { pool } from '@/lib/db';
import { resolvePrincipal } from '@/lib/authz/principal';
import { auditScopeFor, listAuditEvents, type AuditEventRow } from '@/lib/audit/query';
import { FAKE_PRINCIPAL_ADMIN, FAKE_SESSION, NO_PARAMS, makeJsonReq, makePrincipal } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockScope = vi.mocked(auditScopeFor);
const mockList = vi.mocked(listAuditEvents);
const req = (qs = '') => makeJsonReq(`http://localhost/api/admin/audit${qs}`, 'GET');

const UNIT = 'aaaa0000-0000-4000-8000-00000000000a';
const ENTITY = '11111111-1111-4111-8111-111111111111';

const row = (over: Partial<AuditEventRow> = {}): AuditEventRow => ({
  id: '5',
  occurredAt: new Date('2026-10-05T09:00:00.000Z'),
  source: 'server',
  eventType: 'export.download',
  outcome: 'success',
  actorUserId: 'u1',
  actorName: 'Anne',
  actorOrgUnitUuid: UNIT,
  entityType: 'meeting',
  entityId: ENTITY,
  secondaryEntityType: null,
  secondaryEntityId: null,
  ipAddress: '10.0.0.1',
  userAgent: 'UA/1.0',
  requestId: 'r1',
  details: { format: 'pdf' },
  clientOccurredAt: null,
  ...over,
});

const LOG_READER = makePrincipal({
  roles: ['tt-bruger', 'tt-logleser'],
  capabilities: ['template.use', 'audit.read'],
  scopes: { 'audit.read': { global: false, roots: [{ orgUnitUuid: UNIT, includeDescendants: true }] } },
});

beforeEach(() => {
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
  mockScope.mockReset().mockResolvedValue({ all: true });
  mockList.mockReset().mockResolvedValue({ rows: [row()], nextCursor: '5' });
});

describe('GET /api/admin/audit (audit.read)', () => {
  it('401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await GET(req(), NO_PARAMS)).status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it.each([
    ['a plain user', makePrincipal()],
    ['a template manager', makePrincipal({ capabilities: ['template.use', 'template.manage'] })],
    ['someone with export but not read', makePrincipal({ capabilities: ['template.use', 'audit.export'] })],
    ['a disabled administrator', { ...FAKE_PRINCIPAL_ADMIN, disabled: true }],
  ])('403 for %s', async (_l, principal) => {
    mockResolve.mockResolvedValue(principal);
    expect((await GET(req(), NO_PARAMS)).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('a global reader gets rows, the cursor, and the network fields', async () => {
    const res = await GET(req('?limit=20'), NO_PARAMS);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.nextCursor).toBe('5');
    expect(body.events[0]).toMatchObject({
      id: '5',
      occurredAt: '2026-10-05T09:00:00.000Z',
      eventType: 'export.download',
      entityId: ENTITY,
      ipAddress: '10.0.0.1',
      userAgent: 'UA/1.0',
    });
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ scope: { all: true }, limit: 20 }));
  });

  it('a scoped reader is passed the scope and gets NO ip or user agent keys', async () => {
    mockResolve.mockResolvedValue(LOG_READER);
    mockScope.mockResolvedValue({ all: false, orgUnitUuids: [UNIT] });
    const res = await GET(req(), NO_PARAMS);
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ scope: { all: false, orgUnitUuids: [UNIT] } }));
    const event = (await res.json()).events[0];
    expect('ipAddress' in event).toBe(false);
    expect('userAgent' in event).toBe(false);
    expect(JSON.stringify(event)).not.toContain('10.0.0.1');
  });

  it('attaches the change note of a central template event, read from the changelog', async () => {
    const TEMPLATE = '33333333-3333-4333-8333-333333333333';
    mockList.mockResolvedValue({
      rows: [
        row({ id: '8', eventType: 'central_template.update', entityType: 'central_template', entityId: TEMPLATE, details: { version: 3, changedFields: ['prompt'] } }),
        row({ id: '7' }),
      ],
      nextCursor: null,
    });
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ template_id: TEMPLATE, version: 3, change_note: 'Tonen er gjort mere formel efter ønske fra afdelingen.', template_name: 'Referat' }],
    } as never);
    const events = (await (await GET(req(), NO_PARAMS)).json()).events;
    expect(events[0]).toMatchObject({ id: '8', changeNote: 'Tonen er gjort mere formel efter ønske fra afdelingen.', templateName: 'Referat' });
    expect('changeNote' in events[1]).toBe(false);
  });

  it('still returns the log when the changelog lookup fails', async () => {
    mockList.mockResolvedValue({
      rows: [row({ id: '8', eventType: 'central_template.create', entityId: ENTITY, details: { version: 1, targetCount: 1 } })],
      nextCursor: null,
    });
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('boom'));
    const res = await GET(req(), NO_PARAMS);
    expect(res.status).toBe(200);
    expect('changeNote' in (await res.json()).events[0]).toBe(false);
  });

  it('returns only whitelisted fields (a new column does not leak by accident)', async () => {
    mockList.mockResolvedValue({ rows: [{ ...row(), clientEventId: 'secret-ish', extra: 'x' } as AuditEventRow], nextCursor: null });
    const event = (await (await GET(req(), NO_PARAMS)).json()).events[0];
    expect(event).not.toHaveProperty('clientEventId');
    expect(event).not.toHaveProperty('extra');
  });

  it('passes validated filters to the query', async () => {
    await GET(
      req(
        `?eventType=meeting.delete&eventType=meeting.create&outcome=denied&source=client&actorUserId=u9&entityId=${ENTITY}` +
          `&from=2026-10-01T00:00:00.000Z&to=2026-10-05T23:59:59.999Z&cursor=100`,
      ),
      NO_PARAMS,
    );
    const call = mockList.mock.calls[0][0];
    expect(call.cursor).toBe('100');
    expect(call.filters).toEqual({
      eventTypes: ['meeting.delete', 'meeting.create'],
      actorUserId: 'u9',
      entityId: ENTITY,
      outcome: 'denied',
      source: 'client',
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-05T23:59:59.999Z'),
    });
  });

  it('passes a trimmed name search as q, together with the scope', async () => {
    mockResolve.mockResolvedValue(LOG_READER);
    mockScope.mockResolvedValue({ all: false, orgUnitUuids: [UNIT] });
    await GET(req(`?q=${encodeURIComponent('  Mette %_ Æ  ')}&actorUserId=u9`), NO_PARAMS);
    const call = mockList.mock.calls[0][0];
    expect(call.filters).toMatchObject({ q: 'Mette %_ Æ', actorUserId: 'u9' });
    expect(call.scope).toEqual({ all: false, orgUnitUuids: [UNIT] });
  });

  it.each([
    '?q=',
    '?q=%20%20',
    `?q=${'x'.repeat(101)}`,
    '?q=a%00b',
    '?q=a%0Ab',
    '?q=a&q=b',
  ])('400 for %s', async (qs) => {
    expect((await GET(req(qs), NO_PARAMS)).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('accepts a 100 character name search', async () => {
    expect((await GET(req(`?q=${'x'.repeat(100)}`), NO_PARAMS)).status).toBe(200);
  });

  it.each([
    '?limit=0',
    '?limit=101',
    '?limit=abc',
    '?cursor=abc',
    '?cursor=-1',
    '?outcome=bogus',
    '?source=bogus',
    '?eventType=not.an.event',
    '?eventType=toString',
    '?entityId=nope',
    '?actorUserId=has%20space',
    '?from=yesterday',
    '?to=2026-10-05',
    '?outcome=success&outcome=denied',
    '?foo=1',
  ])('400 for %s', async (qs) => {
    const res = await GET(req(qs), NO_PARAMS);
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('a failing query is a JSON 500 that does not leak the error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockList.mockRejectedValue(new Error('relation "audit_events" does not exist'));
    const res = await GET(req(), NO_PARAMS);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('audit_events');
    spy.mockRestore();
  });
});

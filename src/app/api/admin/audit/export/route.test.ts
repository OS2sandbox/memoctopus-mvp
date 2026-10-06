import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/db', () => ({ pool: { query: vi.fn() }, db: {} }));
vi.mock('@/lib/audit/record', () => ({ recordServerEvent: vi.fn() }));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('@/lib/audit/query', async (orig) => ({
  ...(await orig<typeof import('@/lib/audit/query')>()),
  auditScopeFor: vi.fn(),
  collectAuditEvents: vi.fn(),
}));

import { GET } from './route';

import { AUDIT_EXPORT_MAX_ROWS as EXPORT_MAX_ROWS } from '@/lib/audit/csv';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { recordServerEvent } from '@/lib/audit/record';
import { auditScopeFor, collectAuditEvents, type AuditEventRow } from '@/lib/audit/query';
import { FAKE_PRINCIPAL_ADMIN, FAKE_SESSION, NO_PARAMS, makeJsonReq, makePrincipal } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockRecord = vi.mocked(recordServerEvent);
const mockScope = vi.mocked(auditScopeFor);
const mockCollect = vi.mocked(collectAuditEvents);
const req = (qs = '') => makeJsonReq(`http://localhost/api/admin/audit/export${qs}`, 'GET');

const row = (over: Partial<AuditEventRow> = {}): AuditEventRow => ({
  id: '5',
  occurredAt: new Date('2026-10-05T09:00:00.000Z'),
  source: 'server',
  eventType: 'export.download',
  outcome: 'success',
  actorUserId: 'u1',
  actorName: 'Anne',
  actorOrgUnitUuid: null,
  entityType: null,
  entityId: null,
  secondaryEntityType: null,
  secondaryEntityId: null,
  ipAddress: '10.0.0.1',
  userAgent: 'UA/1.0',
  requestId: null,
  details: {},
  clientOccurredAt: null,
  ...over,
});

beforeEach(() => {
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
  mockScope.mockReset().mockResolvedValue({ all: true });
  mockCollect.mockReset().mockResolvedValue({ rows: [row(), row({ id: '4' })], truncated: false });
  mockRecord.mockReset().mockResolvedValue({ status: 'stored' });
});

describe('GET /api/admin/audit/export (audit.export)', () => {
  it('401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    expect((await GET(req(), NO_PARAMS)).status).toBe(401);
    expect(mockCollect).not.toHaveBeenCalled();
  });

  it('403 for a reader without audit.export (reading is not exporting)', async () => {
    mockResolve.mockResolvedValue(makePrincipal({ capabilities: ['template.use', 'audit.read'], scopes: { 'audit.read': { global: true, roots: [] } } }));
    expect((await GET(req(), NO_PARAMS)).status).toBe(403);
    expect(mockCollect).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('returns a CSV attachment', async () => {
    const res = await GET(req(), NO_PARAMS);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="log-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-audit-truncated')).toBe('false');
    expect(res.headers.get('content-disposition')).not.toContain('afkortet');
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM, which text() would strip
    const text = await res.text();
    expect(text.startsWith('Tidspunkt')).toBe(true);
    expect(text.split('\r\n')).toHaveLength(4);
    expect(text).toContain('10.0.0.1');
  });

  it('records audit.export with the row count BEFORE returning, as the acting user', async () => {
    const order: string[] = [];
    mockRecord.mockImplementation(async () => {
      order.push('record');
      return { status: 'stored' };
    });
    const res = await GET(req(), NO_PARAMS);
    order.push('returned');
    expect(order).toEqual(['record', 'returned']);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][1]).toEqual({
      type: 'audit.export',
      actorUserId: FAKE_SESSION.user.id,
      details: { rowCount: 2, format: 'csv' },
    });
    await res.text();
  });

  it('flags a truncated export in the header and in the event', async () => {
    mockCollect.mockResolvedValue({ rows: [row()], truncated: true });
    const res = await GET(req(), NO_PARAMS);
    expect(res.headers.get('x-audit-truncated')).toBe('true');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="log-\d{4}-\d{2}-\d{2}-afkortet\.csv"$/);
    expect(mockRecord.mock.calls[0][1]).toMatchObject({ details: { rowCount: 1, format: 'csv', truncated: true } });
    expect(mockCollect).toHaveBeenCalledWith(expect.objectContaining({ maxRows: EXPORT_MAX_ROWS }));
  });

  it('refuses to hand out the file when the export cannot be recorded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRecord.mockResolvedValue({ status: 'dropped', code: 'db_error' });
    const res = await GET(req(), NO_PARAMS);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).not.toContain('csv');
    expect(await res.text()).not.toContain('Tidspunkt');
    warn.mockRestore();
  });

  it('uses the same filters as the viewer', async () => {
    await GET(req('?eventType=meeting.delete&outcome=denied&from=2026-10-01T00:00:00.000Z'), NO_PARAMS);
    expect(mockCollect.mock.calls[0][0].filters).toMatchObject({
      eventTypes: ['meeting.delete'],
      outcome: 'denied',
      from: new Date('2026-10-01T00:00:00.000Z'),
    });
  });

  it('limits the rows to the caller\'s audit.read scope', async () => {
    mockScope.mockResolvedValue({ all: false, orgUnitUuids: ['aaaa0000-0000-4000-8000-00000000000a'] });
    await GET(req(), NO_PARAMS);
    expect(mockCollect).toHaveBeenCalledWith(expect.objectContaining({ scope: { all: false, orgUnitUuids: ['aaaa0000-0000-4000-8000-00000000000a'] } }));
  });

  it.each(['?cursor=5', '?limit=10', '?outcome=bogus', '?eventType=nope', '?foo=1'])('400 for %s', async (qs) => {
    expect((await GET(req(qs), NO_PARAMS)).status).toBe(400);
    expect(mockCollect).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

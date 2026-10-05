import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/db', () => ({ pool: { query: vi.fn() }, db: {} }));
vi.mock('@/lib/audit/query', async (orig) => ({
  ...(await orig<typeof import('@/lib/audit/query')>()),
  getFeedPage: vi.fn(),
  getFeedHead: vi.fn(),
}));

import { NextRequest } from 'next/server';
import { GET } from './route';
import { GET as HEAD_GET } from './head/route';
import { auth } from '@/lib/auth';
import { getFeedHead, getFeedPage, type AuditEventRow } from '@/lib/audit/query';

const KEY = 'feed-service-key-0123456789';
const hashOf = (k: string) => createHash('sha256').update(k).digest('hex');
const mockPage = vi.mocked(getFeedPage);
const mockHead = vi.mocked(getFeedHead);

const get = (path: string, key: string | null = KEY) =>
  new NextRequest(`http://localhost${path}`, { headers: key === null ? {} : { 'x-audit-key': key } });

const row = (over: Partial<AuditEventRow> = {}): AuditEventRow => ({
  id: '12',
  occurredAt: new Date('2026-10-05T09:00:00.000Z'),
  source: 'server',
  eventType: 'auth.login',
  outcome: 'success',
  actorUserId: 'u1',
  actorName: 'Anne',
  actorOrgUnitUuid: null,
  entityType: null,
  entityId: null,
  secondaryEntityType: null,
  secondaryEntityId: null,
  ipAddress: null,
  userAgent: null,
  requestId: 'r1',
  details: { method: 'sso', provider: 'entra' },
  clientOccurredAt: null,
  ...over,
});

beforeEach(() => {
  vi.stubEnv('AUDIT_FEED_API_KEY_HASH', hashOf(KEY));
  vi.stubEnv('AUDIT_FEED_DELAY_SECONDS', '');
  mockPage.mockReset().mockResolvedValue({ rows: [row()], next: 12 });
  mockHead.mockReset().mockResolvedValue(12);
  vi.mocked(auth.api.getSession).mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe.each([
  ['GET /api/audit/feed', GET, '/api/audit/feed'],
  ['GET /api/audit/feed/head', HEAD_GET, '/api/audit/feed/head'],
] as const)('%s auth', (_name, handler, path) => {
  it('404 when AUDIT_FEED_API_KEY_HASH is unset: the feed does not exist', async () => {
    vi.stubEnv('AUDIT_FEED_API_KEY_HASH', '');
    expect((await handler(get(path))).status).toBe(404);
    expect(mockPage).not.toHaveBeenCalled();
    expect(mockHead).not.toHaveBeenCalled();
  });

  it.each([
    ['no key', null],
    ['a wrong key', 'wrong-key'],
    ['the hash instead of the key', hashOf(KEY)],
  ])('401 for %s, without echoing it', async (_l, key) => {
    const res = await handler(get(path, key));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(key ?? '\u0000');
    expect(mockPage).not.toHaveBeenCalled();
    expect(mockHead).not.toHaveBeenCalled();
  });

  it('does not accept the key as a bearer token or a cookie', async () => {
    const res = await handler(
      new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${KEY}`, cookie: `x-audit-key=${KEY}` } }),
    );
    expect(res.status).toBe(401);
  });

  it('never involves a session', async () => {
    await handler(get(path));
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('never logs the key', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPage.mockRejectedValue(new Error(`boom ${KEY}`));
    mockHead.mockRejectedValue(new Error(`boom ${KEY}`));
    await handler(get(path, KEY));
    await handler(get(path, 'wrong-key'));
    for (const spy of [log, err, warn]) expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
    log.mockRestore();
    err.mockRestore();
    warn.mockRestore();
  });
});

describe('GET /api/audit/feed/head', () => {
  it('returns the head, with the configured delay', async () => {
    vi.stubEnv('AUDIT_FEED_DELAY_SECONDS', '30');
    const res = await HEAD_GET(get('/api/audit/feed/head'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ head: 12 });
    expect(mockHead).toHaveBeenCalledWith(30);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('a failing query is a JSON 500', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockHead.mockRejectedValue(new Error('db down'));
    expect((await HEAD_GET(get('/api/audit/feed/head'))).status).toBe(500);
    err.mockRestore();
  });
});

describe('GET /api/audit/feed', () => {
  it('returns records and the next offset, with defaults offset 0, size 100, delay 10', async () => {
    const res = await GET(get('/api/audit/feed'));
    expect(res.status).toBe(200);
    expect(mockPage).toHaveBeenCalledWith({ offset: 0, size: 100, delaySeconds: 10 });
    const body = await res.json();
    expect(body.next).toBe(12);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({ id: 12, eventType: 'auth.login', requestId: 'r1', details: { method: 'sso', provider: 'entra' } });
  });

  it('passes offset and size through', async () => {
    await GET(get('/api/audit/feed?offset=40&size=500'));
    expect(mockPage).toHaveBeenCalledWith({ offset: 40, size: 500, delaySeconds: 10 });
  });

  it('includes the ip and user agent only when stored', async () => {
    mockPage.mockResolvedValue({ rows: [row(), row({ id: '13', ipAddress: '10.0.0.9', userAgent: 'UA' })], next: 13 });
    const { records } = await (await GET(get('/api/audit/feed'))).json();
    expect('ipAddress' in records[0]).toBe(false);
    expect('userAgent' in records[0]).toBe(false);
    expect(records[1]).toMatchObject({ ipAddress: '10.0.0.9', userAgent: 'UA' });
  });

  it.each(['?offset=-1', '?offset=abc', '?size=0', '?size=1001', '?size=x', '?foo=1', '?offset=1.5'])('400 for %s', async (qs) => {
    expect((await GET(get(`/api/audit/feed${qs}`))).status).toBe(400);
    expect(mockPage).not.toHaveBeenCalled();
  });

  it('authenticates before validating (a bad key never learns what is valid)', async () => {
    expect((await GET(get('/api/audit/feed?size=0', 'wrong'))).status).toBe(401);
  });
});

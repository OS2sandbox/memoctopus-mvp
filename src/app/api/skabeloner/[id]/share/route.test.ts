import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));

const mockGetSkabelon = vi.hoisted(() => vi.fn());
const mockEnsureTable = vi.hoisted(() => vi.fn());
const mockInsertValues = vi.hoisted(() => vi.fn());
const mockGetShareConfig = vi.hoisted(() => vi.fn());

vi.mock('@/lib/skabeloner/server', () => ({ getSkabelon: mockGetSkabelon }));
vi.mock('@/lib/skabeloner/shared-table', () => ({ ensureSharedSkabelonerTable: mockEnsureTable }));
vi.mock('@/lib/skabeloner/share-config', () => ({ getShareConfig: mockGetShareConfig }));
vi.mock('@/lib/db', () => ({ db: { insert: () => ({ values: mockInsertValues }) } }));
vi.mock('@/lib/db/schema', () => ({ sharedSkabeloner: {} }));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const ctx = { params: Promise.resolve({ id: 'abc' }) };
const req = () => makeJsonReq('http://localhost/api/skabeloner/abc/share', 'POST');

describe('POST /api/skabeloner/[id]/share', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(FAKE_SESSION as never);
    mockGetShareConfig.mockReturnValue({ link: true, code: true });
    mockGetSkabelon.mockResolvedValue({
      name: 'N',
      description: 'D',
      prompt: 'SECRET PROMPT',
      includeDeltagere: true,
      includeBeslutningspunkter: true,
      includeDagsorden: true,
      includeDato: true,
    });
    mockEnsureTable.mockResolvedValue(undefined);
    mockInsertValues.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('publishes and returns a token', async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(201);
    expect(typeof (await res.json()).token).toBe('string');
  });

  it('answers 404 for an unknown template', async () => {
    mockGetSkabelon.mockResolvedValue(null);
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it('turns a failing insert into a JSON 500 whose log line carries no message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockInsertValues.mockRejectedValue(new Error('Failing row contains (SECRET PROMPT)'));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET PROMPT');
  });
});

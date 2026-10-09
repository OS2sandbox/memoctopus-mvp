import { describe, it, expect, vi, beforeEach } from 'vitest';

// The access gate (requireAppAccess) resolves the live principal; a plain
// bruger unless a test says otherwise.
vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

const mockEnsureSharedSkabelonerTable = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDbSelect = vi.hoisted(() => vi.fn());
const mockCreateSkabelon = vi.hoisted(() => vi.fn());
const mockGetShareConfig = vi.hoisted(() => vi.fn());
const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/record', () => ({ recordServerEvent: mockRecord }));

vi.mock('@/lib/skabeloner/shared-table', () => ({
  ensureSharedSkabelonerTable: mockEnsureSharedSkabelonerTable,
}));

vi.mock('@/lib/db', () => ({
  db: { select: mockDbSelect },
}));

vi.mock('@/lib/db/schema', () => ({
  sharedSkabeloner: { token: 'token' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ __eq: val })),
}));

vi.mock('@/lib/skabeloner/server', () => ({
  createSkabelon: mockCreateSkabelon,
}));

vi.mock('@/lib/skabeloner/share-config', () => ({
  getShareConfig: mockGetShareConfig,
}));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

const NEW_ID = '11111111-2222-4333-8444-555555555555';
const BASE_URL = 'http://localhost/api/skabeloner/import/abc123';

const sharedRow = {
  token: 'abc123',
  name: 'Bestyrelsesmøde',
  description: 'En skabelon til bestyrelsesmøder',
  prompt: 'Lav et referat.',
  includeDeltagere: true,
  includeBeslutningspunkter: true,
  includeDagsorden: true,
  includeDato: false,
};

function makeCtx(token = 'abc123') {
  return { params: Promise.resolve({ token }) };
}

function setupDbReturning(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  mockDbSelect.mockReturnValue(chain);
  return chain;
}

describe('GET /api/skabeloner/import/[token]', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockGetShareConfig.mockReturnValue({ link: true });
    setupDbReturning([sharedRow]);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await GET(makeJsonReq(BASE_URL, 'GET'), makeCtx());
    expect(res.status).toBe(401);
  });

  it('returns 403 when link sharing is disabled', async () => {
    mockGetShareConfig.mockReturnValueOnce({ link: false });
    const res = await GET(makeJsonReq(BASE_URL, 'GET'), makeCtx());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Linkdeling er deaktiveret');
  });

  it('returns 404 when token is unknown', async () => {
    setupDbReturning([]);
    const res = await GET(makeJsonReq(BASE_URL, 'GET'), makeCtx());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Delingslink er ugyldigt');
  });

  it('returns the skabelon preview on a valid token', async () => {
    const res = await GET(makeJsonReq(BASE_URL, 'GET'), makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skabelon.name).toBe('Bestyrelsesmøde');
    expect(body.skabelon.prompt).toBe('Lav et referat.');
  });

  it('returns JSON 500 with parseable body when the DB throws', async () => {
    mockEnsureSharedSkabelonerTable.mockRejectedValueOnce(new Error('DB connection refused'));
    const res = await GET(makeJsonReq(BASE_URL, 'GET'), makeCtx());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });
});

describe('POST /api/skabeloner/import/[token]', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockGetShareConfig.mockReturnValue({ link: true });
    setupDbReturning([sharedRow]);
    mockCreateSkabelon.mockReset();
    mockCreateSkabelon.mockResolvedValue({ ...sharedRow, id: NEW_ID });
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({ status: 'stored' });
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), makeCtx());
    expect(res.status).toBe(401);
  });

  it('returns 403 when link sharing is disabled', async () => {
    mockGetShareConfig.mockReturnValueOnce({ link: false });
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), makeCtx());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Linkdeling er deaktiveret');
  });

  it('returns 404 when token is unknown', async () => {
    setupDbReturning([]);
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), makeCtx());
    expect(res.status).toBe(404);
  });

  it('creates and returns the imported skabelon with status 201', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), makeCtx());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.skabelon.id).toBe(NEW_ID);
    expect(mockCreateSkabelon).toHaveBeenCalledWith('user-123', expect.objectContaining({ name: 'Bestyrelsesmøde' }));
  });

  it('returns JSON 500 with parseable body when createSkabelon throws', async () => {
    mockCreateSkabelon.mockRejectedValueOnce(new Error('DB write failed'));
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), makeCtx());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  it('emits template.import once for the NEW copy, without token or content', async () => {
    await POST(makeJsonReq(BASE_URL, 'POST'), makeCtx());
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [, event] = mockRecord.mock.calls[0];
    expect(event).toEqual({
      type: 'template.import',
      actorUserId: 'user-123',
      entityId: NEW_ID,
      details: { kind: 'link' },
    });
    expect(JSON.stringify(event)).not.toMatch(/abc123|Bestyrelsesmøde|Lav et referat/);
  });

  it('does not emit for 403/404 or a preview GET', async () => {
    mockGetShareConfig.mockReturnValueOnce({ link: false });
    await POST(makeJsonReq(BASE_URL, 'POST'), makeCtx());
    setupDbReturning([]);
    await POST(makeJsonReq(BASE_URL, 'POST'), makeCtx());
    setupDbReturning([sharedRow]);
    await GET(makeJsonReq(BASE_URL, 'GET'), makeCtx());
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('still returns 201 when the audit write is dropped', async () => {
    mockRecord.mockResolvedValue({ status: 'dropped', code: 'db_error' });
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), makeCtx());
    expect(res.status).toBe(201);
  });
});

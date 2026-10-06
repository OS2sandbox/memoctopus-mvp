import { describe, it, expect, vi, beforeEach } from 'vitest';

// The access gate (requireAppAccess) resolves the live principal; a plain
// tt-bruger unless a test says otherwise.
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

const mockInsertValues = vi.hoisted(() => vi.fn());
const mockGetSkabelon = vi.hoisted(() => vi.fn());
const mockGetShareConfig = vi.hoisted(() => vi.fn());
const mockRecord = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  db: { insert: vi.fn(() => ({ values: mockInsertValues })) },
}));
vi.mock('@/lib/db/schema', () => ({ sharedSkabeloner: {} }));
vi.mock('@/lib/skabeloner/server', () => ({ getSkabelon: mockGetSkabelon }));
vi.mock('@/lib/skabeloner/share-config', () => ({ getShareConfig: mockGetShareConfig }));
vi.mock('@/lib/skabeloner/shared-table', () => ({
  ensureSharedSkabelonerTable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/audit/record', () => ({ recordServerEvent: mockRecord }));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

const SK_ID = '11111111-2222-4333-8444-555555555555';
const BASE_URL = `http://localhost/api/skabeloner/${SK_ID}/share`;
const CTX = { params: Promise.resolve({ id: SK_ID }) };

const SAMPLE = {
  id: SK_ID,
  name: 'Fortrolig titel',
  description: 'Fortrolig beskrivelse',
  prompt: 'Fortrolig prompt',
  includeDeltagere: true,
  includeBeslutningspunkter: false,
  includeDagsorden: false,
  includeDato: false,
};

describe('POST /api/skabeloner/[id]/share', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockGetShareConfig.mockReturnValue({ link: true });
    mockGetSkabelon.mockReset();
    mockGetSkabelon.mockResolvedValue(SAMPLE);
    mockInsertValues.mockReset();
    mockInsertValues.mockResolvedValue(undefined);
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({ status: 'stored' });
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), CTX);
    expect(res.status).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('returns 403 when link sharing is disabled and emits nothing', async () => {
    mockGetShareConfig.mockReturnValue({ link: false });
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), CTX);
    expect(res.status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('returns 404 when the skabelon does not exist and emits nothing', async () => {
    mockGetSkabelon.mockResolvedValue(null);
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), CTX);
    expect(res.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('returns the token and emits template.share once without the token or content', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), CTX);
    expect(res.status).toBe(201);
    const { token } = await res.json();
    expect(typeof token).toBe('string');
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [, event] = mockRecord.mock.calls[0];
    expect(event).toEqual({
      type: 'template.share',
      actorUserId: 'user-123',
      entityId: SK_ID,
      details: { kind: 'link' },
    });
    expect(JSON.stringify(event)).not.toContain(token);
    expect(JSON.stringify(event)).not.toContain('Fortrolig');
  });

  it('still returns 201 when the audit write is dropped', async () => {
    mockRecord.mockResolvedValue({ status: 'dropped', code: 'db_error' });
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), CTX);
    expect(res.status).toBe(201);
  });

  it('is wrapped by withHandler: a failing insert gives a parseable JSON 500', async () => {
    mockInsertValues.mockRejectedValueOnce(new Error('DB write failed'));
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), CTX);
    expect(res.status).toBe(500);
    expect(typeof (await res.json()).error).toBe('string');
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

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

const mockSetDefaultSkabelon = vi.hoisted(() => vi.fn());
const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/record', () => ({ recordServerEvent: mockRecord }));

const mockSetCentralDefault = vi.hoisted(() => vi.fn());
vi.mock('@/lib/skabeloner/server', () => ({
  setDefaultSkabelon: mockSetDefaultSkabelon,
  setCentralDefault: mockSetCentralDefault,
}));

const mockListCentral = vi.hoisted(() => vi.fn());
vi.mock('@/lib/skabeloner/resolve', () => ({ listCentralForUser: mockListCentral }));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

const SK_ID = '11111111-2222-4333-8444-555555555555';
const BASE_URL = `http://localhost/api/skabeloner/${SK_ID}/default`;
const sampleSkabelon = {
  id: SK_ID,
  name: 'Bestyrelsesmøde',
  description: '',
  prompt: '',
  includeDeltagere: true,
  includeBeslutningspunkter: true,
  includeDagsorden: true,
  includeDato: false,
  isDefault: true,
  createdAt: '',
  updatedAt: '',
};

function makeReq() {
  return new Request(BASE_URL, { method: 'POST' });
}

describe('POST /api/skabeloner/[id]/default', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockSetDefaultSkabelon.mockReset();
    mockSetDefaultSkabelon.mockResolvedValue(sampleSkabelon);
    mockRecord.mockReset();
    mockSetCentralDefault.mockReset();
    mockListCentral.mockReset();
    mockListCentral.mockResolvedValue([]);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeReq() as never, { params: Promise.resolve({ id: SK_ID }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when skabelon is not found', async () => {
    mockSetDefaultSkabelon.mockResolvedValueOnce(null);
    const res = await POST(makeReq() as never, { params: Promise.resolve({ id: 'sk-missing' }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Ikke fundet');
  });

  describe('a central template', () => {
    const CENTRAL_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const central = { id: CENTRAL_ID, source: 'central', name: 'Test skabelon', version: 1, locked: true };

    it('becomes the default when it is available to the person', async () => {
      mockSetDefaultSkabelon.mockResolvedValueOnce(null);
      mockListCentral.mockResolvedValueOnce([central]);
      const res = await POST(makeReq() as never, { params: Promise.resolve({ id: CENTRAL_ID }) });
      expect(res.status).toBe(200);
      expect((await res.json()).centralSkabelon).toMatchObject({ id: CENTRAL_ID, isDefault: true });
      expect(mockSetCentralDefault).toHaveBeenCalledWith('user-123', CENTRAL_ID);
    });

    it('answers the same 404 when it is not available to the person (unknown, archived, not a recipient)', async () => {
      mockSetDefaultSkabelon.mockResolvedValueOnce(null);
      mockListCentral.mockResolvedValueOnce([{ ...central, id: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee' }]);
      const res = await POST(makeReq() as never, { params: Promise.resolve({ id: CENTRAL_ID }) });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('Ikke fundet');
      expect(mockSetCentralDefault).not.toHaveBeenCalled();
    });

    it('does not look at the central list when the id is a personal template', async () => {
      await POST(makeReq() as never, { params: Promise.resolve({ id: SK_ID }) });
      expect(mockListCentral).not.toHaveBeenCalled();
      expect(mockSetCentralDefault).not.toHaveBeenCalled();
    });

    it('writes no audit event either', async () => {
      mockSetDefaultSkabelon.mockResolvedValueOnce(null);
      mockListCentral.mockResolvedValueOnce([central]);
      await POST(makeReq() as never, { params: Promise.resolve({ id: CENTRAL_ID }) });
      expect(mockRecord).not.toHaveBeenCalled();
    });
  });

  it('returns the updated skabelon on success', async () => {
    const res = await POST(makeReq() as never, { params: Promise.resolve({ id: SK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skabelon).toEqual(sampleSkabelon);
    expect(mockSetDefaultSkabelon).toHaveBeenCalledWith('user-123', SK_ID);
  });

  it('returns JSON 500 with parseable body when setDefaultSkabelon throws', async () => {
    mockSetDefaultSkabelon.mockRejectedValueOnce(new Error('DB connection refused'));
    const res = await POST(makeReq() as never, { params: Promise.resolve({ id: SK_ID }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  it('writes no audit event: choosing a default is a preference, not an audited action', async () => {
    await POST(makeReq() as never, { params: Promise.resolve({ id: SK_ID }) });
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

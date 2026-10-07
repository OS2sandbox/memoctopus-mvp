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

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: mockRecord,
}));
vi.mock('@/lib/db', () => ({ db: {}, pool: {} }));

vi.mock('@/lib/skabeloner/server', () => ({
  getSkabelon: vi.fn(),
  updateSkabelon: vi.fn(),
  deleteSkabelon: vi.fn(),
}));

import { GET, PUT, DELETE } from './route';
import { auth } from '@/lib/auth';
import { getSkabelon, updateSkabelon, deleteSkabelon } from '@/lib/skabeloner/server';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockGetSkabelon = vi.mocked(getSkabelon);
const mockUpdateSkabelon = vi.mocked(updateSkabelon);
const mockDeleteSkabelon = vi.mocked(deleteSkabelon);

const SK_ID = '11111111-2222-4333-8444-555555555555';
const BASE_URL = `http://localhost/api/skabeloner/${SK_ID}`;
const CTX = { params: Promise.resolve({ id: SK_ID }) };

const SAMPLE_SKABELON = {
  id: SK_ID,
  name: 'Testskabelon',
  description: '',
  prompt: '',
  includeDeltagere: true,
  includeBeslutningspunkter: true,
  includeDagsorden: false,
  includeDato: true,
  isDefault: false,
};

describe('GET /api/skabeloner/[id]', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockGetSkabelon.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await GET(makeJsonReq(BASE_URL, 'GET'), CTX);
    expect(res.status).toBe(401);
  });

  it('returns 404 when skabelon does not exist', async () => {
    mockGetSkabelon.mockResolvedValueOnce(null as never);
    const res = await GET(makeJsonReq(BASE_URL, 'GET'), CTX);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Ikke fundet');
  });

  it('returns the skabelon on success', async () => {
    mockGetSkabelon.mockResolvedValueOnce(SAMPLE_SKABELON as never);
    const res = await GET(makeJsonReq(BASE_URL, 'GET'), CTX);
    expect(res.status).toBe(200);
    expect((await res.json()).skabelon).toMatchObject({ id: SK_ID });
  });

  it('returns a parseable JSON 500 when getSkabelon throws', async () => {
    mockGetSkabelon.mockRejectedValueOnce(new Error('DB connection lost'));
    const res = await GET(makeJsonReq(BASE_URL, 'GET'), CTX);
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const json = await res.json();
    expect(json.error).toBeDefined();
  });
});

describe('PUT /api/skabeloner/[id]', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockUpdateSkabelon.mockReset();
    mockGetSkabelon.mockReset();
    mockGetSkabelon.mockResolvedValue(SAMPLE_SKABELON as never);
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({ status: 'stored' });
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await PUT(makeJsonReq(BASE_URL, 'PUT', { name: 'Ny' }), CTX);
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const res = await PUT(makeJsonReq(BASE_URL, 'PUT', {}), CTX);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Navn er påkrævet');
  });

  it('returns 400 when name is blank whitespace', async () => {
    const res = await PUT(makeJsonReq(BASE_URL, 'PUT', { name: '   ' }), CTX);
    expect(res.status).toBe(400);
  });

  it('returns 404 when skabelon does not exist', async () => {
    mockGetSkabelon.mockResolvedValueOnce(null as never);
    const res = await PUT(makeJsonReq(BASE_URL, 'PUT', { name: 'Ny' }), CTX);
    expect(res.status).toBe(404);
    expect(mockUpdateSkabelon).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('returns 404 and emits nothing when the row disappears before the update', async () => {
    mockUpdateSkabelon.mockResolvedValueOnce(null as never);
    const res = await PUT(makeJsonReq(BASE_URL, 'PUT', { name: 'Ny' }), CTX);
    expect(res.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('emits template.update once listing only the changed field names', async () => {
    mockUpdateSkabelon.mockResolvedValueOnce({
      ...SAMPLE_SKABELON,
      name: 'Fortrolig titel',
      prompt: 'Fortrolig prompt',
      includeDato: false,
    } as never);
    const res = await PUT(makeJsonReq(BASE_URL, 'PUT', { name: 'Fortrolig titel' }), CTX);
    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [, event] = mockRecord.mock.calls[0];
    expect(event).toEqual({
      type: 'template.update',
      actorUserId: 'user-123',
      entityId: SK_ID,
      details: { changedFields: ['name', 'prompt', 'includeDato'] },
    });
    expect(JSON.stringify(event)).not.toMatch(/Fortrolig|Testskabelon/);
  });

  it('records a failed update as outcome error without field values, and still answers a JSON 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUpdateSkabelon.mockRejectedValueOnce(new Error('DB error for Fortrolig titel'));
    const res = await PUT(makeJsonReq(BASE_URL, 'PUT', { name: 'Fortrolig titel', prompt: 'Fortrolig prompt' }), CTX);
    expect(res.status).toBe(500);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][1]).toEqual({
      type: 'template.update',
      outcome: 'error',
      actorUserId: 'user-123',
      entityId: SK_ID,
      details: { changedFields: [] },
    });
    expect(JSON.stringify(mockRecord.mock.calls)).not.toContain('Fortrolig');
  });

  it('emits nothing when no tracked field changed, but still returns the skabelon', async () => {
    mockUpdateSkabelon.mockResolvedValueOnce({ ...SAMPLE_SKABELON } as never);
    const res = await PUT(makeJsonReq(BASE_URL, 'PUT', { name: 'Testskabelon' }), CTX);
    expect(res.status).toBe(200);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('still returns 200 when the audit write is dropped', async () => {
    mockUpdateSkabelon.mockResolvedValueOnce({ ...SAMPLE_SKABELON, name: 'Ny' } as never);
    mockRecord.mockResolvedValue({ status: 'dropped', code: 'db_error' });
    const res = await PUT(makeJsonReq(BASE_URL, 'PUT', { name: 'Ny' }), CTX);
    expect(res.status).toBe(200);
  });

  it('returns the updated skabelon on success', async () => {
    const updated = { ...SAMPLE_SKABELON, name: 'Ny' };
    mockUpdateSkabelon.mockResolvedValueOnce(updated as never);
    const res = await PUT(makeJsonReq(BASE_URL, 'PUT', { name: 'Ny' }), CTX);
    expect(res.status).toBe(200);
    expect((await res.json()).skabelon.name).toBe('Ny');
  });

  it('returns a parseable JSON 500 when updateSkabelon throws', async () => {
    mockUpdateSkabelon.mockRejectedValueOnce(new Error('DB timeout'));
    const res = await PUT(makeJsonReq(BASE_URL, 'PUT', { name: 'Ny' }), CTX);
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const json = await res.json();
    expect(json.error).toBeDefined();
  });
});

describe('DELETE /api/skabeloner/[id]', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockDeleteSkabelon.mockReset();
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({ status: 'stored' });
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'), CTX);
    expect(res.status).toBe(401);
  });

  it('returns 404 when skabelon does not exist', async () => {
    mockDeleteSkabelon.mockResolvedValueOnce(false as never);
    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'), CTX);
    expect(res.status).toBe(404);
  });

  it('returns ok on success', async () => {
    mockDeleteSkabelon.mockResolvedValueOnce(true as never);
    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'), CTX);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('emits template.delete once with the id only', async () => {
    mockDeleteSkabelon.mockResolvedValueOnce(true as never);
    await DELETE(makeJsonReq(BASE_URL, 'DELETE'), CTX);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][1]).toEqual({ type: 'template.delete', actorUserId: 'user-123', entityId: SK_ID });
  });

  it('records a failed delete as outcome error (with the id, no content) and still answers a JSON 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDeleteSkabelon.mockRejectedValueOnce(new Error('DB error for Hr. Jensen'));
    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'), CTX);
    expect(res.status).toBe(500);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][1]).toEqual({ type: 'template.delete', outcome: 'error', actorUserId: 'user-123', entityId: SK_ID });
    expect(JSON.stringify(mockRecord.mock.calls)).not.toContain('Jensen');
  });

  it('a failed delete of an id that is not a uuid is recorded without an entity', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDeleteSkabelon.mockRejectedValueOnce(new Error('x'));
    await DELETE(makeJsonReq(`${BASE_URL}x`, 'DELETE'), { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(mockRecord.mock.calls[0][1]).toEqual({ type: 'template.delete', outcome: 'error', actorUserId: 'user-123' });
  });

  it('does not emit when nothing was deleted', async () => {
    mockDeleteSkabelon.mockResolvedValueOnce(false as never);
    await DELETE(makeJsonReq(BASE_URL, 'DELETE'), CTX);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('still returns ok when the audit write is dropped', async () => {
    mockDeleteSkabelon.mockResolvedValueOnce(true as never);
    mockRecord.mockResolvedValue({ status: 'dropped', code: 'db_error' });
    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'), CTX);
    expect(res.status).toBe(200);
  });

  it('returns a parseable JSON 500 when deleteSkabelon throws', async () => {
    mockDeleteSkabelon.mockRejectedValueOnce(new Error('DB error'));
    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'), CTX);
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const json = await res.json();
    expect(json.error).toBeDefined();
  });
});

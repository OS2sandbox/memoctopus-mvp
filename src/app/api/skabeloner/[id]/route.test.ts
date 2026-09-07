import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

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

const BASE_URL = 'http://localhost/api/skabeloner/sk-1';
const CTX = { params: Promise.resolve({ id: 'sk-1' }) };

const SAMPLE_SKABELON = {
  id: 'sk-1',
  name: 'Testskabelon',
  description: null,
  prompt: null,
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
    expect((await res.json()).skabelon).toMatchObject({ id: 'sk-1' });
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
    mockUpdateSkabelon.mockResolvedValueOnce(null as never);
    const res = await PUT(makeJsonReq(BASE_URL, 'PUT', { name: 'Ny' }), CTX);
    expect(res.status).toBe(404);
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

  it('returns a parseable JSON 500 when deleteSkabelon throws', async () => {
    mockDeleteSkabelon.mockRejectedValueOnce(new Error('DB error'));
    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'), CTX);
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const json = await res.json();
    expect(json.error).toBeDefined();
  });
});

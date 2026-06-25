import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/skabeloner/server', () => ({
  listSkabeloner: vi.fn(),
  createSkabelon: vi.fn(),
}));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { listSkabeloner, createSkabelon } from '@/lib/skabeloner/server';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockList = vi.mocked(listSkabeloner);
const mockCreate = vi.mocked(createSkabelon);

const BASE_URL = 'http://localhost/api/skabeloner';

const FAKE_SKABELON = {
  id: 'sk-1',
  name: 'Standardreferat',
  description: '',
  prompt: '',
  includeDeltagere: true,
  includeBeslutningspunkter: true,
  includeDagsorden: false,
  includeDato: false,
  isDefault: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('GET /api/skabeloner', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockList.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await GET();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('returns the list from listSkabeloner', async () => {
    mockList.mockResolvedValue([FAKE_SKABELON]);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skabeloner).toHaveLength(1);
    expect(json.skabeloner[0].id).toBe('sk-1');
  });

  it('returns a parseable JSON 500 when listSkabeloner throws', async () => {
    mockList.mockRejectedValue(new Error('DB connection refused'));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const json = await res.json();
    expect(json.error).toBeDefined();
  });
});

describe('POST /api/skabeloner', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockCreate.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { name: 'Test' }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('returns 400 when name is missing', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Navn er påkrævet');
  });

  it('returns 400 when name is blank whitespace', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { name: '   ' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Navn er påkrævet');
  });

  it('creates and returns the skabelon with status 201', async () => {
    mockCreate.mockResolvedValue(FAKE_SKABELON);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', {
      name: 'Standardreferat',
      description: '',
      prompt: '',
      includeDeltagere: true,
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.skabelon.id).toBe('sk-1');
    expect(mockCreate).toHaveBeenCalledWith('user-123', expect.objectContaining({ name: 'Standardreferat' }));
  });

  it('returns a parseable JSON 500 when createSkabelon throws', async () => {
    mockCreate.mockRejectedValue(new Error('DB write failed'));
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { name: 'Test' }));
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const json = await res.json();
    expect(json.error).toBeDefined();
  });

  it('treats a non-JSON body as empty (400 on missing name)', async () => {
    const req = new Request(BASE_URL, { method: 'POST', body: 'not-json', headers: { 'Content-Type': 'text/plain' } });
    // req.json() will throw; the .catch(() => ({})) fallback returns {} → name is missing
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });
});

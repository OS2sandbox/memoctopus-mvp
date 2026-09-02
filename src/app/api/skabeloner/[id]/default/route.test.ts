import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

const mockSetDefaultSkabelon = vi.hoisted(() => vi.fn());

vi.mock('@/lib/skabeloner/server', () => ({
  setDefaultSkabelon: mockSetDefaultSkabelon,
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

const BASE_URL = 'http://localhost/api/skabeloner/sk-1/default';
const sampleSkabelon = {
  id: 'sk-1',
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
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeReq() as never, { params: Promise.resolve({ id: 'sk-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when skabelon is not found', async () => {
    mockSetDefaultSkabelon.mockResolvedValueOnce(null);
    const res = await POST(makeReq() as never, { params: Promise.resolve({ id: 'sk-missing' }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Ikke fundet');
  });

  it('returns the updated skabelon on success', async () => {
    const res = await POST(makeReq() as never, { params: Promise.resolve({ id: 'sk-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skabelon).toEqual(sampleSkabelon);
    expect(mockSetDefaultSkabelon).toHaveBeenCalledWith('user-123', 'sk-1');
  });

  it('returns JSON 500 with parseable body when setDefaultSkabelon throws', async () => {
    mockSetDefaultSkabelon.mockRejectedValueOnce(new Error('DB connection refused'));
    const res = await POST(makeReq() as never, { params: Promise.resolve({ id: 'sk-1' }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });
});

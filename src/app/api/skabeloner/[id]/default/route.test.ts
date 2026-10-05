import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

const mockSetDefaultSkabelon = vi.hoisted(() => vi.fn());
const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/record', () => ({ recordServerEvent: mockRecord }));

vi.mock('@/lib/skabeloner/server', () => ({
  setDefaultSkabelon: mockSetDefaultSkabelon,
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

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
    mockRecord.mockResolvedValue({ status: 'stored' });
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

  it('emits template.set_default once with the id only', async () => {
    await POST(makeReq() as never, { params: Promise.resolve({ id: SK_ID }) });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [, event] = mockRecord.mock.calls[0];
    expect(event).toEqual({ type: 'template.set_default', actorUserId: 'user-123', entityId: SK_ID });
    expect(JSON.stringify(event)).not.toContain('Bestyrelsesmøde');
  });

  it('does not emit when the skabelon is not found', async () => {
    mockSetDefaultSkabelon.mockResolvedValueOnce(null);
    await POST(makeReq() as never, { params: Promise.resolve({ id: SK_ID }) });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('still returns 200 when the audit write is dropped', async () => {
    mockRecord.mockResolvedValue({ status: 'dropped', code: 'db_error' });
    const res = await POST(makeReq() as never, { params: Promise.resolve({ id: SK_ID }) });
    expect(res.status).toBe(200);
  });
});

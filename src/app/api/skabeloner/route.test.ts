import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/record', () => ({ recordServerEvent: mockRecord }));

vi.mock('@/lib/skabeloner/server', () => ({
  listSkabeloner: vi.fn(),
  createSkabelon: vi.fn(),
}));

const mockListCentral = vi.hoisted(() => vi.fn());
vi.mock('@/lib/skabeloner/resolve', () => ({ listCentralForUser: mockListCentral }));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { listSkabeloner, createSkabelon } from '@/lib/skabeloner/server';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockList = vi.mocked(listSkabeloner);
const mockCreate = vi.mocked(createSkabelon);

const BASE_URL = 'http://localhost/api/skabeloner';
const SK_ID = '11111111-2222-4333-8444-555555555555';
const CENTRAL_ID = '99999999-2222-4333-8444-555555555555';

const FAKE_SKABELON = {
  id: SK_ID,
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
    mockListCentral.mockReset();
    mockListCentral.mockResolvedValue([]);
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
    expect(json.skabeloner[0].id).toBe(SK_ID);
  });

  it('returns the central summaries for the session user next to the personal list', async () => {
    const central = { id: CENTRAL_ID, source: 'central', name: 'Dialogmøde', locked: true, version: 3 };
    mockList.mockResolvedValue([FAKE_SKABELON]);
    mockListCentral.mockResolvedValue([central]);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skabeloner).toEqual([FAKE_SKABELON]);
    expect(json.centralSkabeloner).toEqual([central]);
    expect(mockListCentral).toHaveBeenCalledWith('user-123');
  });

  it('keeps the personal list and answers an empty central list when central resolution fails', async () => {
    mockList.mockResolvedValue([FAKE_SKABELON]);
    mockListCentral.mockRejectedValue(Object.assign(new Error('relation x: Hemmelig prompt'), { code: '42P01' }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skabeloner).toHaveLength(1);
    expect(json.centralSkabeloner).toEqual([]);
    // safeLogError: class name and code only, never the message.
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Hemmelig');
    spy.mockRestore();
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
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({ status: 'stored' });
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
    expect(json.skabelon.id).toBe(SK_ID);
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

  it('emits template.create once with the new id and no content in details', async () => {
    mockCreate.mockResolvedValue({ ...FAKE_SKABELON, prompt: 'Hemmelig prompt om Hr. Jensen' });
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { name: 'Standardreferat', prompt: 'Hemmelig prompt om Hr. Jensen' }));
    expect(res.status).toBe(201);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [, event] = mockRecord.mock.calls[0];
    expect(event).toEqual({
      type: 'template.create',
      actorUserId: 'user-123',
      entityId: SK_ID,
      details: { hasPrompt: true },
    });
    expect(JSON.stringify(event)).not.toMatch(/Standardreferat|Hemmelig|Jensen/);
  });

  it('does not emit on validation failure', async () => {
    await POST(makeJsonReq(BASE_URL, 'POST', {}));
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('still returns 201 when the audit write is dropped', async () => {
    mockCreate.mockResolvedValue(FAKE_SKABELON);
    mockRecord.mockResolvedValue({ status: 'dropped', code: 'db_error' });
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { name: 'Test' }));
    expect(res.status).toBe(201);
  });
});

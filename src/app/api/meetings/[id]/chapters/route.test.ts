import { describe, it, expect, vi, beforeEach } from 'vitest';

// The access gate (requireAppAccess) resolves the live principal; a plain
// tt-bruger unless a test says otherwise.
vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));

const mockGroupIntoChapters = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/chapters', () => ({
  groupIntoChapters: mockGroupIntoChapters,
}));

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

import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

const BASE_URL = 'http://localhost/api/meetings/meet-1/chapters';
const PARAMS = { params: Promise.resolve({ id: 'meet-1' }) };

const sampleSegments = [
  { speaker: 'Taler 1', start: 0, end: 5, text: 'Punkt et.' },
  { speaker: 'Taler 2', start: 6, end: 10, text: 'Punkt to.' },
];

const sampleChapters = [
  { id: 'ch-0', title: 'Indledning', summary: 'S', startTime: 0, endTime: 5, segmentIndices: [0] },
  { id: 'ch-1', title: 'Diskussion', summary: 'S', startTime: 6, endTime: 10, segmentIndices: [1] },
];

// The route generates chapters via AI and returns them; it does NOT persist —
// the client stores them in IndexedDB. There is no auth or DB access.
describe('POST /api/meetings/[id]/chapters', () => {
  beforeEach(() => {
    mockGroupIntoChapters.mockReset();
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);
    expect(res.status).toBe(401);
    expect(mockGroupIntoChapters).not.toHaveBeenCalled();
  });

  it('returns generated chapters from groupIntoChapters', async () => {
    mockGroupIntoChapters.mockResolvedValueOnce(sampleChapters);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chapters).toHaveLength(2);
    expect(body.chapters[0].title).toBe('Indledning');
    expect(mockGroupIntoChapters).toHaveBeenCalledWith(sampleSegments);
  });

  it('returns an empty chapters array when segments is empty (no AI call)', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: [] }), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).chapters).toEqual([]);
    expect(mockGroupIntoChapters).not.toHaveBeenCalled();
  });

  it('returns an empty chapters array when segments is missing', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', {}), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).chapters).toEqual([]);
    expect(mockGroupIntoChapters).not.toHaveBeenCalled();
  });

  it('fails soft to an empty chapters array when groupIntoChapters throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const aiError = new Error('AI error');
    mockGroupIntoChapters.mockRejectedValueOnce(aiError);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).chapters).toEqual([]);
    // The log line carries the error name only, never the message or the error object.
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledWith('[chapters route] name=Error');
    consoleErrorSpy.mockRestore();
  });
});

describe('audit', () => {
  it('writes no audit event: pipeline steps are not audited (success, failure or no segments)', async () => {
    mockRecord.mockReset();
    mockGroupIntoChapters.mockReset();
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGroupIntoChapters.mockResolvedValueOnce(sampleChapters);
    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);
    mockGroupIntoChapters.mockRejectedValueOnce(new Error('down'));
    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);
    await POST(makeJsonReq(BASE_URL, 'POST', { segments: [] }), PARAMS);
    spy.mockRestore();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

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
import { expectValidMetadataOnly, leakyError } from '@/app/api/meetings/ai-audit.test-utils';
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

describe('audit: chapters.request', () => {
  const MEETING = '11111111-2222-4333-8444-555555555555';
  const UUID_PARAMS = { params: Promise.resolve({ id: MEETING }) };
  const events = () => mockRecord.mock.calls.map((c) => c[1]);
  beforeEach(() => {
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({ status: 'stored' });
  });

  beforeEach(() => {
    mockGroupIntoChapters.mockReset();
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  });

  it('emits one event with counts and duration only', async () => {
    mockGroupIntoChapters.mockResolvedValueOnce(sampleChapters);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), UUID_PARAMS);
    expect(res.status).toBe(200);

    expect(events()).toHaveLength(1);
    const e = events()[0];
    expect(e).toMatchObject({
      type: 'chapters.request',
      actorUserId: 'user-123',
      entityId: MEETING,
      details: { segmentCount: 2, chapterCount: 2 },
    });
    expect(typeof e.details.durationMs).toBe('number');
    expectValidMetadataOnly(e, ['Indledning', 'Diskussion', 'Punkt et']);
  });

  it('omits the entity for a non-UUID id', async () => {
    mockGroupIntoChapters.mockResolvedValueOnce(sampleChapters);
    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), PARAMS);
    expect(events()[0].entityId).toBeUndefined();
    expectValidMetadataOnly(events()[0], ['meet-1']);
  });

  it('records outcome error with a code and keeps the empty fallback response', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGroupIntoChapters.mockRejectedValueOnce(leakyError('Punkt et', { code: 'ETIMEDOUT' }));
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), UUID_PARAMS);

    expect(res.status).toBe(200);
    expect((await res.json()).chapters).toEqual([]);
    expect(events()[0]).toMatchObject({ outcome: 'error', details: { outcomeCode: 'timeout' } });
    expectValidMetadataOnly(events()[0], ['Punkt et']);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Punkt et');
    spy.mockRestore();
  });

  it('still answers when the audit write rejects', async () => {
    mockGroupIntoChapters.mockResolvedValueOnce(sampleChapters);
    mockRecord.mockResolvedValueOnce({ status: 'dropped', code: 'db_error' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), UUID_PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).chapters).toHaveLength(2);
    warn.mockRestore();
  });

  it('emits nothing for 401 or when there are no segments', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }), UUID_PARAMS);
    await POST(makeJsonReq(BASE_URL, 'POST', { segments: [] }), UUID_PARAMS);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

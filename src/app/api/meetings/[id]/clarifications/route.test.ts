import { describe, it, expect, vi, beforeEach } from 'vitest';

// The access gate (requireAppAccess) resolves the live principal; a plain
// tt-bruger unless a test says otherwise.
vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));

const mockAnalyzeClarifications = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/ai/clarifications', () => ({
  analyzeClarifications: mockAnalyzeClarifications,
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

const BASE_URL = 'http://localhost/api/meetings/meet-1/clarifications';
const PARAMS = { params: Promise.resolve({ id: 'meet-1' }) };

const sampleClarifications = [
  { question: 'Hvem er ansvarlig for budgettet?', context: 'Budget 2024' },
  { question: 'Hvornår er deadline?', context: 'Personalemøde' },
];

// ─── POST /api/meetings/[id]/clarifications ──────────────────────────────────

describe('POST /api/meetings/[id]/clarifications', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockAnalyzeClarifications.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'text' }), PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns empty clarifications when transcript is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', {}), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).clarifications).toEqual([]);
    expect(mockAnalyzeClarifications).not.toHaveBeenCalled();
  });

  it('returns empty clarifications when transcript is whitespace only', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { transcript: '   ' }), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).clarifications).toEqual([]);
    expect(mockAnalyzeClarifications).not.toHaveBeenCalled();
  });

  it('returns analyzed clarifications on success', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockAnalyzeClarifications.mockResolvedValueOnce(sampleClarifications);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'Vi diskuterer budget.' }), PARAMS);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clarifications).toHaveLength(2);
    expect(body.clarifications[0].question).toBe('Hvem er ansvarlig for budgettet?');
  });

  it('returns empty clarifications on analyzeClarifications error', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockAnalyzeClarifications.mockRejectedValueOnce(new Error('LLM error'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'text' }), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).clarifications).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0][0]).toContain('[clarifications route]');
    consoleSpy.mockRestore();
  });

  it('passes the transcript to analyzeClarifications', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockAnalyzeClarifications.mockResolvedValueOnce([]);

    await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'budgetmøde transskription' }), PARAMS);

    expect(mockAnalyzeClarifications).toHaveBeenCalledWith('budgetmøde transskription');
  });
});

describe('audit', () => {
  it('writes no audit event: pipeline steps are not audited (success, failure or rejected input)', async () => {
    mockRecord.mockReset();
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAnalyzeClarifications.mockResolvedValueOnce(sampleClarifications);
    await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'Budget 2024 er uklart' }), PARAMS);
    mockAnalyzeClarifications.mockRejectedValueOnce(new Error('down'));
    await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'tekst' }), PARAMS);
    await POST(makeJsonReq(BASE_URL, 'POST', { transcript: '  ' }), PARAMS);
    spy.mockRestore();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

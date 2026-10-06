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
import { clarificationCoalescer } from './coalesce';
import { expectValidMetadataOnly, leakyError } from '@/app/api/meetings/ai-audit.test-utils';
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

describe('audit: clarifications.request', () => {
  const MEETING = '11111111-2222-4333-8444-555555555555';
  const UUID_PARAMS = { params: Promise.resolve({ id: MEETING }) };
  const events = () => mockRecord.mock.calls.map((c) => c[1]);
  beforeEach(() => {
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({ status: 'stored' });
    clarificationCoalescer.clear();
  });

  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockAnalyzeClarifications.mockReset();
  });

  it('emits one event with the question count and duration only', async () => {
    mockAnalyzeClarifications.mockResolvedValueOnce(sampleClarifications);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'Budget 2024 er uklart' }), UUID_PARAMS);
    expect(res.status).toBe(200);

    expect(events()).toHaveLength(1);
    const e = events()[0];
    expect(e).toMatchObject({
      type: 'clarifications.request',
      actorUserId: 'user-123',
      entityId: MEETING,
      details: { questionCount: 2 },
    });
    expect(typeof e.details.durationMs).toBe('number');
    expectValidMetadataOnly(e, ['Budget', 'ansvarlig', 'deadline', 'Personalemøde']);
  });

  it('writes one event per actor+meeting per hour however often the recording screen polls, but keeps success and error apart', async () => {
    mockAnalyzeClarifications.mockResolvedValue(sampleClarifications);
    for (let i = 0; i < 12; i++) {
      const res = await POST(makeJsonReq(BASE_URL, 'POST', { transcript: `tekst ${i}` }), UUID_PARAMS);
      expect(res.status).toBe(200);
      expect((await res.json()).clarifications).toHaveLength(2);
    }
    expect(mockAnalyzeClarifications).toHaveBeenCalledTimes(12);
    expect(events()).toHaveLength(1);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAnalyzeClarifications.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 5; i++) await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'tekst' }), UUID_PARAMS);
    spy.mockRestore();
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({ outcome: 'error' });

    // Another meeting is not suppressed by the first.
    mockAnalyzeClarifications.mockResolvedValue([]);
    await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'tekst' }), { params: Promise.resolve({ id: '99999999-2222-4333-8444-555555555555' }) });
    expect(events()).toHaveLength(3);
  });

  it('omits the entity for a non-UUID id', async () => {
    mockAnalyzeClarifications.mockResolvedValueOnce([]);
    await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'tekst' }), PARAMS);
    expect(events()[0].entityId).toBeUndefined();
    expectValidMetadataOnly(events()[0], ['meet-1']);
  });

  it('keys non-UUID ids on the actor alone and case variants of a UUID together', async () => {
    mockAnalyzeClarifications.mockResolvedValue([]);
    const p = (id: string) => ({ params: Promise.resolve({ id }) });
    const send = (id: string) => POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'tekst' }), p(id));
    await send('garbage-1');
    await send('garbage-2');
    await send('x'.repeat(5_000));
    expect(events()).toHaveLength(1);
    expect(events()[0].entityId).toBeUndefined();
    await send(MEETING);
    await send(MEETING.toUpperCase());
    expect(events()).toHaveLength(2);
  });

  it('records outcome error with a code, never the message, and keeps the empty fallback', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAnalyzeClarifications.mockRejectedValueOnce(leakyError('Budget 2024', { status: 500 }));
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'Budget 2024' }), UUID_PARAMS);

    expect(res.status).toBe(200);
    expect((await res.json()).clarifications).toEqual([]);
    expect(events()[0]).toMatchObject({ outcome: 'error', details: { outcomeCode: 'http_500' } });
    expectValidMetadataOnly(events()[0], ['Budget']);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Budget');
    spy.mockRestore();
  });

  it('still answers when the audit write rejects', async () => {
    mockAnalyzeClarifications.mockResolvedValueOnce(sampleClarifications);
    mockRecord.mockResolvedValueOnce({ status: 'dropped', code: 'db_error' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'tekst' }), UUID_PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).clarifications).toHaveLength(2);
    warn.mockRestore();
  });

  it('emits nothing for 401 or an empty transcript', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    await POST(makeJsonReq(BASE_URL, 'POST', { transcript: 'tekst' }), UUID_PARAMS);
    await POST(makeJsonReq(BASE_URL, 'POST', { transcript: '  ' }), UUID_PARAMS);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

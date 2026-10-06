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

vi.mock('@/lib/bot-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot-service')>();
  return { ...actual, getBotServiceConfig: vi.fn() };
});

vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: vi.fn().mockResolvedValue({ status: 'stored' }),
}));

vi.mock('@/lib/bot-pending-audio', () => ({
  setBotMeetingOwner: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { getBotServiceConfig } from '@/lib/bot-service';
import { recordServerEvent } from '@/lib/audit/record';
import { FAKE_SESSION, makeJsonReq, makePrincipal } from '@/test/helpers';
import { resolvePrincipal } from '@/lib/authz/principal';
import { recordAuthzDenied } from '@/lib/audit/authz-denied';

const mockRecord = vi.mocked(recordServerEvent);

const mockGetSession = vi.mocked(auth.api.getSession);
const mockGetBotConfig = vi.mocked(getBotServiceConfig);
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const URL = 'http://localhost/api/bot/sessions';
const MEETING_URL = 'https://teams.microsoft.com/l/meetup-join/19:meeting_abc@thread.v2/0';
const BOT_CONFIG = { url: 'http://bot:3001', authHeader: 'Bearer test-secret' };

beforeEach(() => {
  mockGetSession.mockReset();
  mockFetch.mockReset();
  mockGetBotConfig.mockReset();
  mockGetBotConfig.mockReturnValue(BOT_CONFIG);
  mockRecord.mockReset().mockResolvedValue({ status: 'stored' });
});

describe('POST /api/bot/sessions', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'm1', meetingUrl: MEETING_URL }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when meetingId is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await POST(makeJsonReq(URL, 'POST', { meetingUrl: MEETING_URL }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when meetingUrl is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'm1' }));
    expect(res.status).toBe(400);
  });

  it('returns 503 when bot service is not configured', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockGetBotConfig.mockReturnValueOnce(null);
    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'm1', meetingUrl: MEETING_URL }));
    expect(res.status).toBe(503);
  });

  it('starts a bot session and returns the sessionId', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'sess-1' }), { status: 200 }));

    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'm1', meetingUrl: MEETING_URL }));
    expect(res.status).toBe(200);
    expect((await res.json()).sessionId).toBe('sess-1');

    const [calledUrl, init] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe('http://bot:3001/sessions');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      meetingUrl: MEETING_URL,
      meetingId: 'm1',
    });
  });

  it('returns 502 when the bot service errors', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'm1', meetingUrl: MEETING_URL }));
    expect(res.status).toBe(502);
  });

  it('returns 503 when the bot service is unreachable', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'm1', meetingUrl: MEETING_URL }));
    expect(res.status).toBe(503);
  });
});

describe('audit: bot.session_start', () => {
  const MEETING = '11111111-1111-4111-8111-111111111111';

  it('emits one bot.session_start with the meeting uuid as entity and no URL or name in the event', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'sess-1' }), { status: 200 }));
    await POST(makeJsonReq(URL, 'POST', { meetingId: MEETING, meetingUrl: MEETING_URL }));

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [, event] = mockRecord.mock.calls[0];
    expect(event).toEqual({ type: 'bot.session_start', actorUserId: FAKE_SESSION.user.id, entityId: MEETING });
    expect(JSON.stringify(event)).not.toContain('teams.microsoft.com');
  });

  it('leaves the entity out when the meetingId is not a uuid (event still recorded)', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'sess-1' }), { status: 200 }));
    await POST(makeJsonReq(URL, 'POST', { meetingId: 'm1', meetingUrl: MEETING_URL }));
    const [, event] = mockRecord.mock.calls[0];
    expect(event.entityId).toBeUndefined();
  });

  it('records outcome error (still once) when the bot service fails', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    await POST(makeJsonReq(URL, 'POST', { meetingId: MEETING, meetingUrl: MEETING_URL }));
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][1]).toMatchObject({ type: 'bot.session_start', outcome: 'error' });
  });

  it('does not record anything for an unauthenticated request', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    await POST(makeJsonReq(URL, 'POST', { meetingId: MEETING, meetingUrl: MEETING_URL }));
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('POST /api/bot/sessions — access gate', () => {
  it('answers 403 for a disabled user and never reaches the bot service', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    vi.mocked(resolvePrincipal).mockResolvedValueOnce(makePrincipal({ disabled: true, roles: [], capabilities: [] }));
    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'm1', meetingUrl: MEETING_URL }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(recordAuthzDenied).toHaveBeenCalledWith(expect.objectContaining({ required: 'login', reason: 'disabled' }));
    expect(mockGetBotConfig).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

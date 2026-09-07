import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('@/lib/bot-pending-audio', () => ({
  setBotMeetingOwner: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { getBotServiceConfig } from '@/lib/bot-service';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchemaOne: vi.fn(),
}));

vi.mock('@/lib/bot-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot-service')>();
  return { ...actual, getBotServiceConfig: vi.fn() };
});

import { POST } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { getBotServiceConfig } from '@/lib/bot-service';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryOne = vi.mocked(queryUserSchemaOne);
const mockGetBotConfig = vi.mocked(getBotServiceConfig);
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const URL = 'http://localhost/api/bot/sessions';
const MEETING = {
  id: 'meet-1',
  status: 'recording',
  source: 'teams',
  meeting_url: 'https://teams.microsoft.com/l/meetup-join/19:meeting_abc@thread.v2/0',
  bot_session: null,
};
const BOT_CONFIG = { url: 'http://bot:3001', authHeader: 'Bearer test-secret' };

beforeEach(() => {
  mockGetSession.mockReset();
  mockQueryOne.mockReset();
  mockFetch.mockReset();
  mockGetBotConfig.mockReturnValue(BOT_CONFIG);
});

afterEach(() => vi.useRealTimers());

describe('POST /api/bot/sessions', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'meet-1' }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('returns 400 when meetingId is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await POST(makeJsonReq(URL, 'POST', {}));
    expect(res.status).toBe(400);
  });

  it('returns 404 when meeting is not found', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'meet-1' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 when meeting source is not teams', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ ...MEETING, source: 'local' } as never);
    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'meet-1' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Not a Teams meeting');
  });

  it('returns 400 when meeting has no meeting_url', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ ...MEETING, meeting_url: null } as never);
    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'meet-1' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('No meeting URL');
  });

  it('returns 503 when bot service is not configured', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never); // claim
    mockGetBotConfig.mockReturnValue(null);
    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'meet-1' }));
    expect(res.status).toBe(503);
  });

  it('creates a session and returns the sessionId', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never); // claim
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sessionId: 'sess-abc' }) });
    mockQueryOne.mockResolvedValueOnce(undefined as never); // update bot_session

    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'meet-1' }));
    expect(res.status).toBe(200);
    expect((await res.json()).sessionId).toBe('sess-abc');
  });

  it('sends correct payload and auth header to bot service', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sessionId: 'sess-abc' }) });
    mockQueryOne.mockResolvedValueOnce(undefined as never);

    await POST(makeJsonReq(URL, 'POST', { meetingId: 'meet-1' }));

    const [fetchUrl, init] = mockFetch.mock.calls[0];
    expect(fetchUrl).toBe('http://bot:3001/sessions');
    expect(init.headers.Authorization).toBe('Bearer test-secret');
    const body = JSON.parse(init.body as string);
    expect(body.meetingUrl).toBe(MEETING.meeting_url);
    expect(body.meetingId).toBe('meet-1');
    expect(body.userId).toBe('user-123');
    expect(body.botName).toBe('Memoctopus');
  });

  it('writes sessionId to meeting row after success', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sessionId: 'sess-xyz' }) });
    mockQueryOne.mockResolvedValueOnce(undefined as never);

    await POST(makeJsonReq(URL, 'POST', { meetingId: 'meet-1' }));

    const updateCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /bot_session = \$1/.test(sql),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![2]).toEqual(['sess-xyz', 'meet-1']);
  });

  it('undoes bot_session claim and returns error when bot service responds non-ok', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'Overloaded' }) });
    mockQueryOne.mockResolvedValueOnce(undefined as never); // undo claim

    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'meet-1' }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('Overloaded');

    const undoCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /bot_session = NULL/.test(sql),
    );
    expect(undoCall).toBeDefined();
  });

  it('returns 503 when bot service is unreachable', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'meet-1' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('Bot service unreachable');
  });

  it('returns 400 from bot service (invalid URL) unchanged', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'Invalid meeting URL' }) });
    mockQueryOne.mockResolvedValueOnce(undefined as never);

    const res = await POST(makeJsonReq(URL, 'POST', { meetingId: 'meet-1' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid meeting URL');
  });

  it('returns existing session when slot already claimed by concurrent request', async () => {
    vi.useFakeTimers();
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(null); // claim fails — already taken
    mockQueryOne.mockResolvedValueOnce({ bot_session: 'existing-sess' } as never);

    const resPromise = POST(makeJsonReq(URL, 'POST', { meetingId: 'meet-1' }));
    await vi.runAllTimersAsync();
    const res = await resPromise;

    expect(res.status).toBe(200);
    expect((await res.json()).sessionId).toBe('existing-sess');
  });
});

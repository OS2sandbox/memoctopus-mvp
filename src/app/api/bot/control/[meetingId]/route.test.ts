import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const MEETING_ID = 'meet-1';
const BOT_CONFIG = { url: 'http://bot:3001', authHeader: 'Bearer test-secret' };
const MEETING_WITH_SESSION = { id: MEETING_ID, bot_session: 'sess-1' };
const MEETING_NO_SESSION = { id: MEETING_ID, bot_session: null };

function postControl(action: string, meetingId = MEETING_ID) {
  return POST(
    makeJsonReq(`http://localhost/api/bot/control/${meetingId}`, 'POST', { action }),
    { params: Promise.resolve({ meetingId }) },
  );
}

beforeEach(() => {
  mockGetSession.mockReset();
  mockQueryOne.mockReset();
  mockFetch.mockReset();
  mockGetBotConfig.mockReturnValue(BOT_CONFIG);
});

describe('POST /api/bot/control/[meetingId]', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await postControl('stop');
    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid action', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await postControl('explode');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid action');
  });

  it('returns 404 when meeting is not found', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await postControl('stop');
    expect(res.status).toBe(404);
  });

  it('returns 503 when bot service is not configured', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING_WITH_SESSION as never);
    mockGetBotConfig.mockReturnValue(null);
    const res = await postControl('stop');
    expect(res.status).toBe(503);
  });

  // ─── abort ───────────────────────────────────────────────────────────────────

  it('abort: calls DELETE on bot service and clears bot_session', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING_WITH_SESSION as never);
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockQueryOne.mockResolvedValueOnce(undefined as never);

    const res = await postControl('abort');
    expect(res.status).toBe(200);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://bot:3001/sessions/sess-1');
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe('Bearer test-secret');

    const dbUpdate = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /bot_session = NULL/.test(sql),
    );
    expect(dbUpdate).toBeDefined();
  });

  it('abort: skips DELETE when meeting has no bot_session', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING_NO_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(undefined as never);

    const res = await postControl('abort');
    expect(res.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('abort: sets meeting status back to recording', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING_WITH_SESSION as never);
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockQueryOne.mockResolvedValueOnce(undefined as never);

    await postControl('abort');

    const dbUpdate = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /status = 'recording'/.test(sql),
    );
    expect(dbUpdate).toBeDefined();
  });

  // ─── pause / resume ───────────────────────────────────────────────────────────

  it.each(['pause', 'resume'])('%s: calls POST /sessions/{id}/%s on bot service', async (action) => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING_WITH_SESSION as never);
    mockFetch.mockResolvedValueOnce({ ok: true });

    const res = await postControl(action);
    expect(res.status).toBe(200);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`http://bot:3001/sessions/sess-1/${action}`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-secret');
  });

  it.each(['pause', 'resume', 'stop'])('%s: returns 400 when there is no active bot session', async (action) => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING_NO_SESSION as never);
    const res = await postControl(action);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('No active bot session');
  });

  // ─── stop ─────────────────────────────────────────────────────────────────────

  it('stop: calls POST /sessions/{id}/stop and updates meeting status to processing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING_WITH_SESSION as never);
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockQueryOne.mockResolvedValueOnce(undefined as never);

    const res = await postControl('stop');
    expect(res.status).toBe(200);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://bot:3001/sessions/sess-1/stop');

    const dbUpdate = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /status = 'processing'/.test(sql),
    );
    expect(dbUpdate).toBeDefined();
  });

  it('returns 502 when bot service returns an error', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING_WITH_SESSION as never);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const res = await postControl('stop');
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('Bot control failed');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The access gate (requireAppAccess) resolves the live principal; a plain
// bruger unless a test says otherwise.
vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

const mockOwner = vi.hoisted(() => vi.fn());
vi.mock('@/lib/bot-pending-audio', () => ({ assertBotMeetingOwner: mockOwner }));

vi.mock('@/lib/bot-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot-service')>();
  return { ...actual, getBotServiceConfig: vi.fn() };
});

import { GET } from './route';
import { auth } from '@/lib/auth';
import { getBotServiceConfig } from '@/lib/bot-service';
import { FAKE_SESSION } from '@/test/helpers';
import { recordAuthzDenied } from '@/lib/audit/authz-denied';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockGetBotConfig = vi.mocked(getBotServiceConfig);
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const BOT_CONFIG = { url: 'http://bot:3001', authHeader: 'Bearer test-secret' };
const params = Promise.resolve({ meetingId: 'm1' });
const SID = '3f2b8c1e-6a4d-4e2f-9b1a-0c5d7e8f9a10';

function req(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/bot/status/m1${query}`);
}

beforeEach(() => {
  mockGetSession.mockReset();
  mockFetch.mockReset();
  mockGetBotConfig.mockReset();
  mockGetBotConfig.mockReturnValue(BOT_CONFIG);
  mockOwner.mockReset().mockResolvedValue(true);
  vi.mocked(recordAuthzDenied).mockClear();
});

describe('GET /api/bot/status/[meetingId] - ownership', () => {
  it('answers a stranger like a session that has not started, never calls the bot, and records the probe', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockOwner.mockResolvedValueOnce(false);
    const MEETING = '11111111-2222-4333-8444-555555555555';
    const res = await GET(req(`?sessionId=${SID}`), { params: Promise.resolve({ meetingId: MEETING }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'forbinder', botStatus: 'idle', participants: [], elapsed: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockOwner).toHaveBeenCalledWith(MEETING, FAKE_SESSION.user.id);
    expect(recordAuthzDenied).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: FAKE_SESSION.user.id, required: 'bot.meeting_owner', reason: 'not_owner', entityType: 'meeting', entityId: MEETING }),
    );
  });
});

describe('GET /api/bot/status/[meetingId]', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await GET(req(`?sessionId=${SID}`), { params });
    expect(res.status).toBe(401);
  });

  it.each(['s1', '..%2Fadmin', '3f2b8c1e-6a4d-4e2f-9b1a-0c5d7e8f9a10%2F..%2Fx'])(
    'returns 400 and never calls the bot for a non-UUID sessionId (%s)',
    async (bad) => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      const res = await GET(req(`?sessionId=${bad}`), { params });
      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it('returns connecting state when no sessionId is provided', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await GET(req(), { params });
    const data = await res.json();
    expect(data.status).toBe('forbinder');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('maps bot recording status to optager with elapsed + participants', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockResolvedValueOnce(new Response(
      JSON.stringify({ status: 'recording', elapsed: 42, participants: ['Anna', '__audio_detected__'] }),
      { status: 200 },
    ));
    const res = await GET(req(`?sessionId=${SID}`), { params });
    const data = await res.json();
    expect(data.status).toBe('optager');
    expect(data.botStatus).toBe('recording');
    expect(data.elapsed).toBe(42);
    expect(data.participants).toEqual(['Anna']); // sentinel filtered out
  });

  it('maps bot ended status to processing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ended' }), { status: 200 }));
    const res = await GET(req(`?sessionId=${SID}`), { params });
    const data = await res.json();
    expect(data.status).toBe('processing');
    expect(data.botStatus).toBe('ended');
  });

  it('returns connecting fallback when bot service is unreachable', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const connErr = new Error('ECONNREFUSED');
    mockFetch.mockRejectedValueOnce(connErr);
    const res = await GET(req(`?sessionId=${SID}`), { params });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.status).toBe('forbinder');
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).toContain('[bot/status unreachable');
    expect(line).not.toContain('ECONNREFUSED');
    errorSpy.mockRestore();
  });
});

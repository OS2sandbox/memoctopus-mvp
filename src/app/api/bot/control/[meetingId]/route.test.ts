import { describe, it, expect, vi, beforeEach } from 'vitest';

// The access gate (requireAppAccess) resolves the live principal; a plain
// tt-bruger unless a test says otherwise.
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

vi.mock('@/lib/bot-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot-service')>();
  return { ...actual, getBotServiceConfig: vi.fn() };
});

vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: vi.fn().mockResolvedValue({ status: 'stored' }),
}));

vi.mock('@/lib/bot-pending-audio', () => ({
  assertBotMeetingOwner: vi.fn(),
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { getBotServiceConfig } from '@/lib/bot-service';
import { assertBotMeetingOwner } from '@/lib/bot-pending-audio';
import { recordServerEvent } from '@/lib/audit/record';
import { FAKE_SESSION } from '@/test/helpers';

const mockRecord = vi.mocked(recordServerEvent);
const MEETING = '11111111-1111-4111-8111-111111111111';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockGetBotConfig = vi.mocked(getBotServiceConfig);
const mockAssertOwner = vi.mocked(assertBotMeetingOwner);
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const BOT_CONFIG = { url: 'http://bot:3001', authHeader: 'Bearer test-secret' };
const params = Promise.resolve({ meetingId: 'm1' });

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/bot/control/m1', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  mockGetSession.mockReset();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
  mockGetBotConfig.mockReset();
  mockGetBotConfig.mockReturnValue(BOT_CONFIG);
  mockAssertOwner.mockReset();
  mockAssertOwner.mockResolvedValue(true);
  mockRecord.mockReset().mockResolvedValue({ status: 'stored' });
});

describe('POST /api/bot/control/[meetingId]', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(req({ action: 'pause', sessionId: 's1' }), { params });
    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid action', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await POST(req({ action: 'nope', sessionId: 's1' }), { params });
    expect(res.status).toBe(400);
  });

  it('returns 404 and never touches the bot when the meeting belongs to another user', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockAssertOwner.mockResolvedValueOnce(false);
    const res = await POST(req({ action: 'stop', sessionId: 'userA-session' }), { params });
    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 400 for pause without a sessionId', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await POST(req({ action: 'pause' }), { params });
    expect(res.status).toBe(400);
  });

  it('forwards stop to the bot service', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await POST(req({ action: 'stop', sessionId: 's1' }), { params });
    expect(res.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe('http://bot:3001/sessions/s1/stop');
  });

  it('forwards pause to the bot service', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    await POST(req({ action: 'pause', sessionId: 's1' }), { params });
    expect(mockFetch.mock.calls[0][0]).toBe('http://bot:3001/sessions/s1/pause');
  });

  it('aborts by deleting the bot session (idempotent, ok with no session)', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await POST(req({ action: 'abort', sessionId: 's1' }), { params });
    expect(res.status).toBe(200);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://bot:3001/sessions/s1');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('logs a warning and still returns 200 when abort DELETE fails (idempotent)', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(req({ action: 'abort', sessionId: 's1' }), { params });
    expect(res.status).toBe(200);
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).toContain('[bot/control abort DELETE');
    expect(line).not.toContain('network down');
    errorSpy.mockRestore();
  });

  it('returns 502 and logs console.error on network failure for stop', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockRejectedValueOnce(new Error('connection refused'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(req({ action: 'stop', sessionId: 's1' }), { params });
    expect(res.status).toBe(502);
    const [msg] = errorSpy.mock.calls[0];
    expect(msg).toContain('[bot/control');
    expect(msg).toContain('action="stop"');
    expect(msg).not.toContain('connection refused');
    errorSpy.mockRestore();
  });

  it('returns 502 and logs console.error when bot returns non-ok for pause', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockResolvedValueOnce(new Response('error', { status: 503 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(req({ action: 'pause', sessionId: 's1' }), { params });
    expect(res.status).toBe(502);
    // Single string arg for non-ok branch (no error object to bind)
    const [msg] = errorSpy.mock.calls[0];
    expect(msg).toContain('[bot/control]');
    expect(msg).toContain('action="pause"');
    expect(msg).toContain('503');
    errorSpy.mockRestore();
  });
});

describe('audit: bot.session_* events', () => {
  const uuidParams = Promise.resolve({ meetingId: MEETING });

  it.each([
    ['pause', 'bot.session_pause'],
    ['resume', 'bot.session_resume'],
    ['stop', 'bot.session_stop'],
    ['abort', 'bot.session_abort'],
  ] as const)('%s emits exactly one %s with the meeting uuid and no details', async (action, type) => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await POST(req({ action, sessionId: 's1' }), { params: uuidParams });
    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][1]).toEqual({
      type,
      outcome: 'success',
      actorUserId: FAKE_SESSION.user.id,
      entityId: MEETING,
    });
  });

  it('records outcome error when the bot rejects the action', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockResolvedValueOnce(new Response('x', { status: 503 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await POST(req({ action: 'pause', sessionId: 's1' }), { params: uuidParams });
    errorSpy.mockRestore();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][1]).toMatchObject({ type: 'bot.session_pause', outcome: 'error' });
  });

  it('emits nothing for a non-owner (404) or an invalid action', async () => {
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockAssertOwner.mockResolvedValueOnce(false);
    await POST(req({ action: 'stop', sessionId: 's1' }), { params: uuidParams });
    await POST(req({ action: 'nope' }), { params: uuidParams });
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

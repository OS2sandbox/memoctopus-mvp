import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('@/lib/bot-pending-audio', () => ({
  assertBotMeetingOwner: vi.fn(),
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { getBotServiceConfig } from '@/lib/bot-service';
import { assertBotMeetingOwner } from '@/lib/bot-pending-audio';
import { FAKE_SESSION } from '@/test/helpers';

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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(req({ action: 'abort', sessionId: 's1' }), { params });
    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[bot/control]'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('returns 502 and logs console.error on network failure for stop', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockRejectedValueOnce(new Error('connection refused'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(req({ action: 'stop', sessionId: 's1' }), { params });
    expect(res.status).toBe(502);
    // First arg is the label+action string, second is the caught error
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[bot/control]'),
      expect.any(Error),
    );
    const [msg] = errorSpy.mock.calls[0];
    expect(msg).toContain('action="stop"');
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

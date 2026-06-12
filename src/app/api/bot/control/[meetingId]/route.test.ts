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

import { POST } from './route';
import { auth } from '@/lib/auth';
import { getBotServiceConfig } from '@/lib/bot-service';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockGetBotConfig = vi.mocked(getBotServiceConfig);
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
});

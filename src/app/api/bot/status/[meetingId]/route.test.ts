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

import { GET } from './route';
import { auth } from '@/lib/auth';
import { getBotServiceConfig } from '@/lib/bot-service';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockGetBotConfig = vi.mocked(getBotServiceConfig);
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const BOT_CONFIG = { url: 'http://bot:3001', authHeader: 'Bearer test-secret' };
const params = Promise.resolve({ meetingId: 'm1' });

function req(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/bot/status/m1${query}`);
}

beforeEach(() => {
  mockGetSession.mockReset();
  mockFetch.mockReset();
  mockGetBotConfig.mockReset();
  mockGetBotConfig.mockReturnValue(BOT_CONFIG);
});

describe('GET /api/bot/status/[meetingId]', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await GET(req('?sessionId=s1'), { params });
    expect(res.status).toBe(401);
  });

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
    const res = await GET(req('?sessionId=s1'), { params });
    const data = await res.json();
    expect(data.status).toBe('optager');
    expect(data.botStatus).toBe('recording');
    expect(data.elapsed).toBe(42);
    expect(data.participants).toEqual(['Anna']); // sentinel filtered out
  });

  it('maps bot ended status to processing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ended' }), { status: 200 }));
    const res = await GET(req('?sessionId=s1'), { params });
    const data = await res.json();
    expect(data.status).toBe('processing');
    expect(data.botStatus).toBe('ended');
  });

  it('returns connecting fallback when bot service is unreachable', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await GET(req('?sessionId=s1'), { params });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.status).toBe('forbinder');
  });
});

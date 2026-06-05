import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

const MEETING_ID = 'meet-st-1';
const PARAMS = { params: Promise.resolve({ id: MEETING_ID }) };
const BASE_URL = `http://localhost/api/meetings/${MEETING_ID}/stream-token`;

// ─── POST /api/meetings/[id]/stream-token ────────────────────────────────────

describe('POST /api/meetings/[id]/stream-token', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), PARAMS);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('returns 200 with token on successful ElevenLabs response', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'tok_abc123' }), { status: 200 }),
    );

    const res = await POST(makeJsonReq(BASE_URL, 'POST'), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe('tok_abc123');
  });

  it('returns 500 when ElevenLabs API returns an error', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('Service Unavailable', { status: 503 }),
    );

    const res = await POST(makeJsonReq(BASE_URL, 'POST'), PARAMS);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to get streaming token');
  });

  it('calls the correct ElevenLabs endpoint with POST method', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'tok_xyz' }), { status: 200 }),
    );

    await POST(makeJsonReq(BASE_URL, 'POST'), PARAMS);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('sends the ElevenLabs API key in the xi-api-key header', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key-999';
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'tok_xyz' }), { status: 200 }),
    );

    await POST(makeJsonReq(BASE_URL, 'POST'), PARAMS);

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect((init as RequestInit & { headers: Record<string, string> }).headers['xi-api-key']).toBe(
      'test-key-999',
    );
  });

  it('returns 500 when the ElevenLabs fetch itself throws', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network failure'));

    await expect(POST(makeJsonReq(BASE_URL, 'POST'), PARAMS)).rejects.toThrow('Network failure');
  });
});

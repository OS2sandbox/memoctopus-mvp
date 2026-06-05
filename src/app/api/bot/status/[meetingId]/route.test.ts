import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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

import { GET } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { getBotServiceConfig } from '@/lib/bot-service';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryOne = vi.mocked(queryUserSchemaOne);
const mockGetBotConfig = vi.mocked(getBotServiceConfig);
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const MEETING_ID = 'meet-1';
const BOT_CONFIG = { url: 'http://bot:3001', authHeader: 'Bearer test-secret' };
const MEETING = {
  id: MEETING_ID,
  status: 'recording',
  source: 'teams',
  bot_session: 'sess-1',
  participants: ['Alice', 'Bob'],
};

function getStatus(meetingId = MEETING_ID) {
  return GET(
    new NextRequest(`http://localhost/api/bot/status/${meetingId}`),
    { params: Promise.resolve({ meetingId }) },
  );
}

beforeEach(() => {
  mockGetSession.mockReset();
  mockQueryOne.mockReset();
  mockFetch.mockReset();
  mockGetBotConfig.mockReturnValue(BOT_CONFIG);
});

describe('GET /api/bot/status/[meetingId]', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await getStatus();
    expect(res.status).toBe(401);
  });

  it('returns 404 when meeting is not found', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await getStatus();
    expect(res.status).toBe(404);
  });

  it('returns forbinder + meetingStatus=cancelled when meeting is cancelled', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ ...MEETING, status: 'cancelled', bot_session: null } as never);
    const res = await getStatus();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('forbinder');
    expect(body.meetingStatus).toBe('cancelled');
    expect(body.participants).toEqual([]);
  });

  it('returns forbinder without calling bot service when bot_session is null', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ ...MEETING, bot_session: null } as never);
    const res = await getStatus();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('forbinder');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(body.participants).toEqual(MEETING.participants);
  });

  it('returns 503 when bot service is not configured', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockGetBotConfig.mockReturnValue(null);
    const res = await getStatus();
    expect(res.status).toBe(503);
  });

  it.each([
    ['joining',   'forbinder'],
    ['recording', 'optager'],
    ['paused',    'pause'],
    ['ended',     'processing'],
    ['error',     'error'],
    ['unknown',   'forbinder'],
  ])('maps bot status %s → UI status %s', async (botStatus, expected) => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ ...MEETING, status: 'recording' } as never);
    mockQueryOne.mockResolvedValueOnce(undefined as never); // potential DB update
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: botStatus, participants: [], elapsed: 0 }),
    });

    const res = await getStatus();
    const body = await res.json();
    expect(body.status).toBe(expected);
  });

  it('updates meeting status to processing when bot reports ended', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ ...MEETING, status: 'recording' } as never);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ended', participants: [], elapsed: 100 }),
    });
    mockQueryOne.mockResolvedValueOnce(undefined as never);

    await getStatus();

    const dbUpdate = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && /status = 'processing'/.test(sql),
    );
    expect(dbUpdate).toBeDefined();
  });

  it('does not update DB when bot reports ended and meeting is already processing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ ...MEETING, status: 'processing' } as never);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ended', participants: [], elapsed: 100 }),
    });

    await getStatus();
    expect(mockQueryOne).toHaveBeenCalledTimes(1); // only the initial meeting lookup
  });

  it('filters __audio_detected__ sentinel from participants', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'recording',
        participants: ['Alice', '__audio_detected__', 'Bob'],
        elapsed: 0,
      }),
    });

    const body = await (await getStatus()).json();
    expect(body.participants).toEqual(['Alice', 'Bob']);
    expect(body.participants).not.toContain('__audio_detected__');
  });

  it('falls back to DB participants when bot reports none', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ ...MEETING, participants: ['Carol'] } as never);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'recording', participants: [], elapsed: 0 }),
    });

    const body = await (await getStatus()).json();
    expect(body.participants).toEqual(['Carol']);
  });

  it('returns processing/review when bot session is gone and meeting is at review', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ ...MEETING, status: 'review' } as never);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const body = await (await getStatus()).json();
    expect(body.status).toBe('processing');
    expect(body.meetingStatus).toBe('review');
  });

  it('returns processing/processing when bot session is gone and meeting is still processing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ ...MEETING, status: 'processing' } as never);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const body = await (await getStatus()).json();
    expect(body.status).toBe('processing');
    expect(body.meetingStatus).toBe('processing');
  });

  it('returns 502 when bot session is gone and meeting is in an unexpected state', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ ...MEETING, status: 'recording' } as never);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const res = await getStatus();
    expect(res.status).toBe(502);
  });

  it('includes elapsed and meetingStatus in response', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ ...MEETING, status: 'recording' } as never);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'recording', participants: [], elapsed: 42 }),
    });

    const body = await (await getStatus()).json();
    expect(body.elapsed).toBe(42);
    expect(body.meetingStatus).toBe('recording');
  });
});

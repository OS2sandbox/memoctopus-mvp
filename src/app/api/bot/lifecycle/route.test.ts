import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/audit/record', () => ({
  recordServerEvent: vi.fn().mockResolvedValue({ status: 'stored' }),
}));

const limit = vi.fn();
vi.mock('@/lib/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) },
}));

import { POST } from './route';
import { recordServerEvent } from '@/lib/audit/record';

const mockRecord = vi.mocked(recordServerEvent);
const SECRET = 'test-bot-secret';
const MEETING = '11111111-1111-4111-8111-111111111111';

function req(body: unknown, auth: string | null = `Bearer ${SECRET}`): NextRequest {
  return new NextRequest('http://localhost/api/bot/lifecycle', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
  });
}

beforeEach(() => {
  process.env.BOT_INTERNAL_SECRET = SECRET;
  mockRecord.mockReset().mockResolvedValue({ status: 'stored' });
  limit.mockReset().mockResolvedValue([{ id: 'user-123' }]);
});

describe('POST /api/bot/lifecycle', () => {
  it('rejects a missing, wrong or different-length secret with 401 and records nothing', async () => {
    const body = { userId: 'user-123', meetingId: MEETING, event: 'joined' };
    expect((await POST(req(body, null))).status).toBe(401);
    expect((await POST(req(body, 'Bearer nope'))).status).toBe(401);
    expect((await POST(req(body, `Bearer ${SECRET}x`))).status).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('answers 401 when BOT_INTERNAL_SECRET is unset, even for "Bearer undefined"', async () => {
    delete process.env.BOT_INTERNAL_SECRET;
    const res = await POST(req({ userId: 'u', meetingId: MEETING, event: 'joined' }, 'Bearer undefined'));
    expect(res.status).toBe(401);
  });

  it('rejects invalid bodies with 400', async () => {
    for (const bad of [
      'not json',
      { userId: 'user-123', meetingId: 'm1', event: 'joined' },
      { userId: 'user-123', meetingId: MEETING, event: 'started' },
      { userId: 'user-123', meetingId: MEETING, event: 'error', code: 'has spaces and prose' },
      { userId: 'user-123', meetingId: MEETING, event: 'joined', meetingUrl: 'https://teams.microsoft.com/x' },
    ]) {
      expect((await POST(req(bad))).status).toBe(400);
    }
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('records bot.joined once with source system, the user as actor and the meeting uuid', async () => {
    const res = await POST(req({ userId: 'user-123', meetingId: MEETING, event: 'joined' }));
    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][1]).toEqual({
      type: 'bot.joined', source: 'system', actorUserId: 'user-123', entityId: MEETING,
    });
  });

  it('records bot.ended with the code as reason', async () => {
    await POST(req({ userId: 'user-123', meetingId: MEETING, event: 'ended', code: 'meeting_ended' }));
    expect(mockRecord.mock.calls[0][1]).toMatchObject({
      type: 'bot.ended', source: 'system', details: { reason: 'meeting_ended' },
    });
  });

  it('records bot.error with the code, falling back to "unknown"', async () => {
    await POST(req({ userId: 'user-123', meetingId: MEETING, event: 'error', code: 'start_failed' }));
    await POST(req({ userId: 'user-123', meetingId: MEETING, event: 'error' }));
    expect(mockRecord.mock.calls[0][1]).toMatchObject({ type: 'bot.error', details: { code: 'start_failed' } });
    expect(mockRecord.mock.calls[1][1]).toMatchObject({ type: 'bot.error', details: { code: 'unknown' } });
  });

  it('uses a null actor when the user does not exist', async () => {
    limit.mockResolvedValueOnce([]);
    await POST(req({ userId: 'ghost', meetingId: MEETING, event: 'joined' }));
    expect(mockRecord.mock.calls[0][1]).toMatchObject({ actorUserId: null });
    expect(JSON.stringify(mockRecord.mock.calls[0][1])).not.toContain('ghost');
  });
});

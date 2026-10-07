import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: { query: vi.fn() }, db: {} }));
const sweep = vi.hoisted(() => vi.fn());
vi.mock('@/lib/bot-pending-audio', () => ({ sweepPendingBotData: sweep }));

import { NextRequest } from 'next/server';
import { POST } from './route';

const SECRET = 'cron-secret-value';
const post = (secret: string | null = SECRET) =>
  new NextRequest('http://localhost/api/internal/bot-audio/sweep', {
    method: 'POST',
    headers: secret === null ? {} : { 'x-cron-secret': secret },
  });

beforeEach(() => {
  vi.stubEnv('INTERNAL_CRON_SECRET', SECRET);
  sweep.mockReset().mockResolvedValue({ audio: 2, transcripts: 1, owners: 3 });
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/internal/bot-audio/sweep', () => {
  it('404 when INTERNAL_CRON_SECRET is unset', async () => {
    vi.stubEnv('INTERNAL_CRON_SECRET', '');
    expect((await POST(post())).status).toBe(404);
    expect(sweep).not.toHaveBeenCalled();
  });

  it.each([
    ['no secret', null],
    ['a wrong secret', 'nope'],
    ['a near miss', `${SECRET}x`],
  ])('401 for %s, and nothing is deleted', async (_l, secret) => {
    const res = await POST(post(secret));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SECRET);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('runs the sweep and reports what it removed (counts only)', async () => {
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audio: 2, transcripts: 1, owners: 3 });
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});

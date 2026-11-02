import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: { query: vi.fn() }, db: {} }));
vi.mock('@/lib/audit/prune', () => ({ pruneAuditEvents: vi.fn() }));
vi.mock('@/lib/audit/record', () => ({ recordEvent: vi.fn(), recordServerEvent: vi.fn() }));

import { NextRequest } from 'next/server';
import { POST } from './route';
import { pruneAuditEvents } from '@/lib/audit/prune';
import { recordEvent, recordServerEvent } from '@/lib/audit/record';

const SECRET = 'cron-secret-value';
const mockPrune = vi.mocked(pruneAuditEvents);
const post = (secret: string | null = SECRET) =>
  new NextRequest('http://localhost/api/internal/audit/prune', {
    method: 'POST',
    headers: secret === null ? {} : { 'x-cron-secret': secret },
  });

beforeEach(() => {
  vi.stubEnv('INTERNAL_CRON_SECRET', SECRET);
  vi.stubEnv('AUDIT_RETENTION_DAYS', '90');
  mockPrune.mockReset().mockResolvedValue(7);
  vi.mocked(recordEvent).mockReset();
  vi.mocked(recordServerEvent).mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/internal/audit/prune', () => {
  it('404 when INTERNAL_CRON_SECRET is unset', async () => {
    vi.stubEnv('INTERNAL_CRON_SECRET', '');
    expect((await POST(post())).status).toBe(404);
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it.each([
    ['no secret', null],
    ['a wrong secret', 'nope'],
    ['a near miss', `${SECRET}x`],
  ])('401 for %s, and nothing is deleted', async (_l, secret) => {
    const res = await POST(post(secret));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SECRET);
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it('prunes with the 365-day default when AUDIT_RETENTION_DAYS is unset or empty', async () => {
    vi.stubEnv('AUDIT_RETENTION_DAYS', '');
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pruned: 7, retentionDays: 365 });
    expect(mockPrune).toHaveBeenCalledWith({ olderThanDays: 365 });
  });

  it('still needs the cron secret with the default retention', async () => {
    vi.stubEnv('AUDIT_RETENTION_DAYS', '');
    expect((await POST(post('nope'))).status).toBe(401);
    expect((await POST(post(null))).status).toBe(401);
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it.each(['0', 'off', 'false', 'never', 'forever', 'NEVER'])(
    'is a no-op for the explicit opt-out (%s): keep forever',
    async (v) => {
      vi.stubEnv('AUDIT_RETENTION_DAYS', v);
      const res = await POST(post());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pruned: 0, disabled: true });
      expect(mockPrune).not.toHaveBeenCalled();
    },
  );

  it.each(['abc', '-5', '1.5', 'nej'])(
    'an invalid AUDIT_RETENTION_DAYS (%s) falls back to the 365-day default and prunes',
    async (v) => {
      vi.stubEnv('AUDIT_RETENTION_DAYS', v);
      expect(await (await POST(post())).json()).toEqual({ pruned: 7, retentionDays: 365 });
      expect(mockPrune).toHaveBeenCalledWith({ olderThanDays: 365 });
    },
  );

  it('prunes with the configured retention and reports the count', async () => {
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pruned: 7, retentionDays: 90 });
    expect(mockPrune).toHaveBeenCalledWith({ olderThanDays: 90 });
  });

  it('does not record audit.prune itself (pruneAuditEvents does)', async () => {
    await POST(post());
    expect(recordEvent).not.toHaveBeenCalled();
    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  it('a failing prune is a JSON 500 without the error text', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPrune.mockRejectedValue(new Error('connection to 10.1.2.3 refused'));
    const res = await POST(post());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('10.1.2.3');
    err.mockRestore();
  });
});

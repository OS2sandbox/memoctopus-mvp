import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
// record.ts opens the database at import time; only the write is replaced here,
// validateEvent stays the real pure function so the catalogue is really applied.
vi.mock('@/lib/db', () => ({ db: {}, pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: vi.fn(),
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { recordServerEvent } from '@/lib/audit/record';
import { __resetClientEventBudgets, RATE_LIMIT_EVENTS } from '@/lib/audit/client-ingest';
import { makeJsonReq, makePrincipal, NO_PARAMS } from '@/test/helpers';

const mockSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockRecord = vi.mocked(recordServerEvent);

const SESSION = { user: { id: 'user-123', name: 'Anna' }, session: { id: 's1' } };
const MEETING = '11111111-2222-4333-8444-555555555555';
const EVENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const ev = (over: Record<string, unknown> = {}) => ({
  clientEventId: EVENT_ID,
  occurredAt: new Date().toISOString(),
  type: 'meeting.delete',
  entityId: MEETING,
  details: {},
  ...over,
});
const send = (body: unknown) => POST(makeJsonReq('http://localhost/api/audit/client-events', 'POST', body), NO_PARAMS);

beforeEach(() => {
  __resetClientEventBudgets();
  mockSession.mockReset().mockResolvedValue(SESSION as never);
  mockResolve.mockReset().mockResolvedValue(makePrincipal());
  mockRecord.mockReset().mockResolvedValue({ status: 'stored' });
});
afterEach(() => vi.useRealTimers());

describe('POST /api/audit/client-events', () => {
  it('401 without a session and records nothing', async () => {
    mockSession.mockResolvedValueOnce(null as never);
    expect((await send({ events: [ev()] })).status).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('403 for a disabled user', async () => {
    mockResolve.mockResolvedValue(makePrincipal({ disabled: true, capabilities: [], roles: [] }));
    expect((await send({ events: [ev()] })).status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('records one client event with actor from the session and answers {accepted} only', async () => {
    const res = await send({ events: [ev({ type: 'meeting.status_change', details: { fromStatus: 'review', toStatus: 'minutes' } })] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const input = mockRecord.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(input).toMatchObject({
      type: 'meeting.status_change',
      source: 'client',
      actorUserId: 'user-123',
      entityId: MEETING,
      clientEventId: EVENT_ID,
      details: { fromStatus: 'review', toStatus: 'minutes' },
    });
    expect(input.clientOccurredAt).toBeInstanceOf(Date);
    // ip / user agent / request id are read from the request itself by recordServerEvent.
    expect((mockRecord.mock.calls[0][0] as { headers: Headers }).headers).toBeInstanceOf(Headers);
  });

  it('rejects an actor / ip / source / time field in the payload (strict parsing)', async () => {
    for (const extra of [{ actorUserId: 'someone-else' }, { ip: '1.2.3.4' }, { source: 'server' }, { occurred_at: 'x' }]) {
      const res = await send({ events: [{ ...ev(), ...extra }] });
      expect(res.status).toBe(400);
    }
    expect((await send({ events: [ev()], actorUserId: 'someone-else' })).status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('accepts only meeting.* types', async () => {
    for (const type of ['auth.login_failed', 'template.delete', 'export.download', 'audit.export', 'authz.denied', 'nope']) {
      expect((await send({ events: [ev({ type })] })).status).toBe(400);
    }
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('rejects details with extra keys or free text and a non-uuid entity id', async () => {
    const bad = [
      ev({ type: 'meeting.rename', details: { title: 'Sag om Jensens barn' } }),
      ev({ type: 'meeting.status_change', details: { fromStatus: 'Vi taler om sagen', toStatus: 'minutes' } }),
      ev({ type: 'meeting.create', details: { origin: 'live', title: 'x' } }),
      ev({ entityId: 'not-a-uuid' }),
      ev({ clientEventId: 'nope' }),
      ev({ occurredAt: 'yesterday' }),
    ];
    for (const e of bad) expect((await send({ events: [e] })).status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('refuses a whole batch that contains one invalid event, before recording any', async () => {
    const res = await send({ events: [ev(), ev({ clientEventId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', details: { x: 1 } })] });
    expect(res.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('400 on an empty list, more than 50 events, and non-JSON', async () => {
    expect((await send({ events: [] })).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) =>
      ev({ clientEventId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, '0')}` }),
    );
    expect((await send({ events: many })).status).toBe(400);
    const res = await POST(
      new Request('http://localhost/api/audit/client-events', { method: 'POST', body: '{nope' }) as never,
      NO_PARAMS,
    );
    expect(res.status).toBe(400);
  });

  it('413 above 32 KB without parsing', async () => {
    const res = await send({ events: [ev()], pad: 'x'.repeat(33 * 1024) });
    expect(res.status).toBe(413);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('accepts 50 events', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) =>
      ev({ clientEventId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, '0')}` }),
    );
    const res = await send({ events: fifty });
    expect(await res.json()).toEqual({ accepted: 50 });
    expect(mockRecord).toHaveBeenCalledTimes(50);
  });

  describe('time clamp', () => {
    const occurredAtOf = async (claimed: string) => {
      await send({ events: [ev({ occurredAt: claimed })] });
      return (mockRecord.mock.calls[0][1] as { clientOccurredAt: Date }).clientOccurredAt;
    };

    it('keeps a plausible client time', async () => {
      const claimed = new Date(Date.now() - 3600_000).toISOString();
      expect((await occurredAtOf(claimed)).toISOString()).toBe(claimed);
    });

    it('replaces a time more than 7 days old with the server time', async () => {
      const t = await occurredAtOf(new Date(Date.now() - 8 * 86400_000).toISOString());
      expect(Math.abs(t.getTime() - Date.now())).toBeLessThan(5000);
    });

    it('replaces a time more than 5 minutes in the future with the server time', async () => {
      const t = await occurredAtOf(new Date(Date.now() + 6 * 60_000).toISOString());
      expect(Math.abs(t.getTime() - Date.now())).toBeLessThan(5000);
    });
  });

  it('treats a duplicate (already stored) event as success', async () => {
    mockRecord.mockResolvedValue({ status: 'duplicate' });
    const res = await send({ events: [ev()] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });
  });

  it('answers 503 when the audit write fails, so the client keeps the batch', async () => {
    mockRecord.mockResolvedValue({ status: 'dropped', code: 'db_error' });
    const res = await send({ events: [ev()] });
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain(MEETING);
  });

  it('a throwing audit write becomes a JSON 500 that echoes nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRecord.mockRejectedValue(new Error('Sag om Jensens barn'));
    const res = await send({ events: [ev()] });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('Jensen');
  });

  it('rate limits per user and says when to retry', async () => {
    const batch = (n: number, off: number) =>
      Array.from({ length: n }, (_, i) =>
        ev({ clientEventId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(off + i).padStart(12, '0')}` }),
      );
    for (let sent = 0; sent < RATE_LIMIT_EVENTS; sent += 50) {
      expect((await send({ events: batch(50, sent) })).status).toBe(200);
    }
    const limited = await send({ events: batch(1, 9999) });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);

    // Another user has a separate budget.
    mockSession.mockResolvedValue({ user: { id: 'user-999' }, session: { id: 's2' } } as never);
    mockResolve.mockResolvedValue(makePrincipal({ userId: 'user-999' }));
    expect((await send({ events: batch(1, 9999) })).status).toBe(200);
  });
});

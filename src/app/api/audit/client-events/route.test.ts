import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
// record.ts opens the database at import time; only the write is replaced here,
// validateEvent stays the real pure function so the catalogue is really applied.
vi.mock('@/lib/db', () => ({ db: {}, pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@/lib/audit/dropped', () => ({ noteDroppedEvents: vi.fn() }));
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: vi.fn(),
  resolveActorSnapshot: vi.fn().mockResolvedValue({ name: null, orgUnitUuid: null }),
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { resolvePrincipal } from '@/lib/authz/principal';
import { recordServerEvent, resolveActorSnapshot, validateEvent } from '@/lib/audit/record';
import { noteDroppedEvents } from '@/lib/audit/dropped';
import { pool } from '@/lib/db';
import { THROTTLE_WINDOW_MS, THROTTLED_TYPES } from '@/lib/audit/client-ingest';
import { __resetClientEventBudgets, RATE_LIMIT_EVENTS } from '@/lib/audit/client-ingest';
import { makeJsonReq, makePrincipal, NO_PARAMS } from '@/test/helpers';

const mockSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockRecord = vi.mocked(recordServerEvent);
const mockCount = vi.mocked(pool.query) as unknown as ReturnType<typeof vi.fn>;
/** What the 24 h count query returns: how many client events the user already has. */
const alreadyStored = (n: number) => mockCount.mockResolvedValue({ rows: [{ n: String(n) }], rowCount: 1 });

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
  mockCount.mockReset();
  alreadyStored(0);
  vi.mocked(noteDroppedEvents).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

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
    const res = await send({ events: [ev({ type: 'meeting.create', details: { origin: 'live' } })] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const input = mockRecord.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(input).toMatchObject({
      type: 'meeting.create',
      source: 'client',
      actorUserId: 'user-123',
      entityId: MEETING,
      clientEventId: EVENT_ID,
      details: { origin: 'live' },
    });
    expect(input.clientOccurredAt).toBeInstanceOf(Date);
    // ip / user agent / request id are read from the request itself by recordServerEvent.
    expect((mockRecord.mock.calls[0][0] as { headers: Headers }).headers).toBeInstanceOf(Headers);
  });

  it('looks the actor up once per request and hands the snapshot to every write', async () => {
    const snapshot = { name: 'Anna', orgUnitUuid: null };
    vi.mocked(resolveActorSnapshot).mockClear().mockResolvedValue(snapshot);
    const events = [1, 2, 3].map((n) => ev({ clientEventId: `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee${n}`, type: 'meeting.create', details: { origin: 'live' } }));
    expect((await send({ events })).status).toBe(200);
    expect(mockRecord).toHaveBeenCalledTimes(3);
    expect(resolveActorSnapshot).toHaveBeenCalledExactlyOnceWith('user-123');
    for (const call of mockRecord.mock.calls) expect(call[2]).toEqual({ actor: snapshot });
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

  it.each([
    ['meeting.status_change', { fromStatus: 'review', toStatus: 'minutes' }],
    ['meeting.rename', {}],
    ['meeting.transcript_edit', { segmentCount: 4 }],
  ])('%s is not reported: refused with 400 and nothing recorded', async (type, details) => {
    expect((await send({ events: [ev({ type, details })] })).status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it.each([
    ['meeting.minutes_view', {}],
    ['meeting.transcript_view', {}],
    ['meeting.audio_play', {}],
    ['meeting.recording_start', {}],
    ['meeting.recording_pause', {}],
    ['meeting.recording_resume', {}],
    ['meeting.recording_stop', {}],
    ['meeting.minutes_save', {}],
    ['meeting.minutes_version', { versionNumber: 2, action: 'activate' }],
    ['meeting.minutes_version_prune', { prunedCount: 2 }],
    ['meeting.participants_edit', { participantCount: 3 }],
    ['meeting.speakers_edit', { speakerCount: 2 }],
    ['meeting.audio_delete', { trigger: 'auto_generate' }],
    ['meeting.delete', { trigger: 'auto_leave' }],
  ])('%s (an action, never content) is recorded with the session as actor', async (type, details) => {
    const res = await send({ events: [ev({ type, details })] });
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(mockRecord.mock.calls[0][1]).toMatchObject({ type, source: 'client', actorUserId: 'user-123', entityId: MEETING, details });
  });

  it('refuses content-like details for the new action events', async () => {
    const bad = [
      ev({ type: 'meeting.participants_edit', details: { participantCount: 2, participants: ['Jens', 'Mette'] } }),
      ev({ type: 'meeting.minutes_version', details: { versionNumber: 2, action: 'Gendannet efter Jensens ønske' } }),
      ev({ type: 'meeting.minutes_view', details: { title: 'Budgetmøde' } }),
      ev({ type: 'meeting.audio_delete', details: { trigger: 'ttl' } }),
    ];
    for (const e of bad) expect((await send({ events: [e] })).status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('rejects details with extra keys or free text and a non-uuid entity id', async () => {
    const bad = [
      ev({ type: 'meeting.delete', details: { title: 'Sag om Jensens barn' } }),
      ev({ type: 'meeting.create', details: { origin: 'Vi taler om sagen' } }),
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

  it('413 for a chunked body without Content-Length, and stops reading at the cap', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(8 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) return controller.close();
        controller.enqueue(chunk);
      },
    });
    const req = new NextRequest('http://localhost/api/audit/client-events', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    });
    expect(req.headers.get('content-length')).toBeNull();
    const res = await POST(req, NO_PARAMS);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(20);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('413 when Content-Length understates the body', async () => {
    const big = JSON.stringify({ events: [ev()], pad: 'x'.repeat(40 * 1024) });
    const req = new NextRequest('http://localhost/api/audit/client-events', {
      method: 'POST',
      body: big,
      headers: { 'content-type': 'application/json', 'content-length': '10' },
    });
    expect((await POST(req, NO_PARAMS)).status).toBe(413);
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

  describe('daily cap', () => {
    const ids = (n: number, off = 0) =>
      Array.from({ length: n }, (_, i) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(off + i).padStart(12, '0')}`);
    const batch = (n: number, off = 0) => ids(n, off).map((clientEventId) => ev({ clientEventId }));

    it('counts only this user, source client, last 24 h, single query, bounded by the cap', async () => {
      await send({ events: [ev()] });
      expect(mockCount).toHaveBeenCalledTimes(1);
      const [sql, params] = mockCount.mock.calls[0] as [string, unknown[]];
      const flat = sql.replace(/\s+/g, ' ');
      expect(flat).toContain('FROM public.audit_events');
      expect(flat).toContain('actor_user_id = $1');
      expect(flat).toContain("source = 'client'");
      expect(flat).toContain("interval '24 hours'");
      expect(params).toEqual(['user-123', 20000]);
    });

    it('stores everything below the cap and omits `capped`', async () => {
      alreadyStored(19990);
      const res = await send({ events: batch(5) });
      expect(await res.json()).toEqual({ accepted: 5 });
    });

    it('boundary: exactly filling the cap is fully accepted, not capped', async () => {
      alreadyStored(19995);
      const res = await send({ events: batch(5) });
      expect(await res.json()).toEqual({ accepted: 5 });
      expect(mockRecord).toHaveBeenCalledTimes(5);
    });

    it('boundary: at the cap nothing is stored, but 200 {accepted:0, capped:true, refused:3} and a warning', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      alreadyStored(20000);
      const res = await send({ events: batch(3) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accepted: 0, capped: true, refused: 3 });
      expect(mockRecord).not.toHaveBeenCalled();
      // Counted, not silent; the warning carries a number only.
      expect(warn).toHaveBeenCalledWith('[audit] client event cap reached, refused=3');
    });

    it('a batch crossing the cap stores the first events in order, counts the rest as refused', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      alreadyStored(19998);
      const list = batch(5);
      const res = await send({ events: list });
      expect(await res.json()).toEqual({ accepted: 2, capped: true, refused: 3 });
      expect(mockRecord).toHaveBeenCalledTimes(2);
      const stored = mockRecord.mock.calls.map((c) => (c[1] as unknown as { clientEventId: string }).clientEventId);
      expect(stored).toEqual(ids(5).slice(0, 2));
    });

    it('honours AUDIT_CLIENT_EVENTS_DAILY_CAP and passes it as the scan limit', async () => {
      vi.stubEnv('AUDIT_CLIENT_EVENTS_DAILY_CAP', '10');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      alreadyStored(8);
      const res = await send({ events: batch(4) });
      expect(await res.json()).toEqual({ accepted: 2, capped: true, refused: 2 });
      expect((mockCount.mock.calls[0] as [string, unknown[]])[1]).toEqual(['user-123', 10]);
    });

    it('an invalid or zero cap setting falls back to 20000', async () => {
      for (const v of ['0', 'abc', '-3']) {
        vi.stubEnv('AUDIT_CLIENT_EVENTS_DAILY_CAP', v);
        mockCount.mockClear();
        alreadyStored(0);
        await send({ events: [ev()] });
        expect((mockCount.mock.calls[0] as [string, unknown[]])[1]).toEqual(['user-123', 20000]);
      }
    });

    it('fails closed: a failing count query is a 503 and nothing is stored', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockCount.mockRejectedValue(new Error('connection to 10.1.2.3 refused'));
      const res = await send({ events: [ev()] });
      expect(res.status).toBe(503);
      expect(JSON.stringify(await res.json())).not.toContain('10.1.2.3');
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('fails closed on an unreadable count (no rows)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockCount.mockResolvedValue({ rows: [], rowCount: 0 });
      expect((await send({ events: [ev()] })).status).toBe(503);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('does not echo input in the capped response', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      alreadyStored(20000);
      const res = await send({ events: [ev()] });
      const text = JSON.stringify(await res.json());
      expect(text).not.toContain(MEETING);
      expect(text).not.toContain(EVENT_ID);
    });
  });

  describe('per-type throttle', () => {
    // The throttle exists for repeatable "look" events (views, playback). The generic
    // mechanism is exercised with meeting.create listed as throttled.
    const CREATE = (n: number, meeting = MEETING) =>
      ev({
        type: 'meeting.create',
        details: { origin: 'live' },
        entityId: meeting,
        clientEventId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`,
      });

    it('throttles views and playback by default, and says so in the response', async () => {
      const view = (n: number) =>
        ev({ type: 'meeting.minutes_view', clientEventId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}` });
      expect(await (await send({ events: [view(1)] })).json()).toEqual({ accepted: 1 });
      expect(await (await send({ events: [view(2)] })).json()).toEqual({ accepted: 0, throttled: 1 });
      expect(mockRecord).toHaveBeenCalledTimes(1);
    });

    it('never throttles edits, versions, recordings or deletes: a repeat is a distinct action', async () => {
      for (const [i, type] of ['meeting.minutes_save', 'meeting.recording_pause', 'meeting.delete'].entries()) {
        const one = ev({ type, clientEventId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(i * 2 + 1).padStart(12, '0')}` });
        const two = ev({ type, clientEventId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(i * 2 + 2).padStart(12, '0')}` });
        expect(await (await send({ events: [one] })).json()).toEqual({ accepted: 1 });
        expect(await (await send({ events: [two] })).json()).toEqual({ accepted: 1 });
      }
      expect(mockRecord).toHaveBeenCalledTimes(6);
    });

    describe('with meeting.create listed as throttled', () => {
      beforeEach(() => void THROTTLED_TYPES.add('meeting.create'));
      afterEach(() => void THROTTLED_TYPES.delete('meeting.create'));

      it('stores the first event and drops (but acknowledges) a repeat within 60 s', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
        expect(await (await send({ events: [CREATE(1)] })).json()).toEqual({ accepted: 1 });
        vi.setSystemTime(new Date('2026-10-05T12:00:59Z'));
        const res = await send({ events: [CREATE(2)] });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ accepted: 0, throttled: 1 });
        expect(mockRecord).toHaveBeenCalledTimes(1);
      });

      it('stores again once the 60 s window has passed', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
        await send({ events: [CREATE(1)] });
        vi.setSystemTime(new Date(Date.parse('2026-10-05T12:00:00Z') + THROTTLE_WINDOW_MS));
        expect(await (await send({ events: [CREATE(2)] })).json()).toEqual({ accepted: 1 });
        expect(mockRecord).toHaveBeenCalledTimes(2);
      });

      it('collapses duplicates inside one batch to the first', async () => {
        const res = await send({ events: [CREATE(1), CREATE(2), CREATE(3)] });
        expect(await res.json()).toEqual({ accepted: 1, throttled: 2 });
        expect(mockRecord).toHaveBeenCalledTimes(1);
      });

      it('is keyed on (actor, meeting, type): other meeting, other type, other user are not throttled', async () => {
        await send({ events: [CREATE(1)] });
        const other = '99999999-2222-4333-8444-555555555555';
        expect(await (await send({ events: [CREATE(2, other)] })).json()).toEqual({ accepted: 1 });
        const del = ev({ clientEventId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000007' });
        expect(await (await send({ events: [del] })).json()).toEqual({ accepted: 1 });
        mockSession.mockResolvedValue({ user: { id: 'user-999' }, session: { id: 's2' } } as never);
        mockResolve.mockResolvedValue(makePrincipal({ userId: 'user-999' }));
        expect(await (await send({ events: [CREATE(3)] })).json()).toEqual({ accepted: 1 });
      });

      it('a failed store does not start the window, so the retry is stored', async () => {
        mockRecord.mockResolvedValueOnce({ status: 'dropped', code: 'db_error' });
        expect((await send({ events: [CREATE(1)] })).status).toBe(503);
        expect(await (await send({ events: [CREATE(1)] })).json()).toEqual({ accepted: 1 });
      });

      it('throttled events do not use the daily cap (no count query when nothing is left to store)', async () => {
        await send({ events: [CREATE(1)] });
        mockCount.mockClear();
        await send({ events: [CREATE(2)] });
        expect(mockCount).not.toHaveBeenCalled();
      });

      it('a throttled event is not reported as capped', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        alreadyStored(20000);
        // First one is capped (dropped), nothing was stored so nothing is throttled either.
        expect(await (await send({ events: [CREATE(1)] })).json()).toEqual({ accepted: 0, capped: true, refused: 1 });
      });
    });
  });
});

describe('view throttle in EVENT time', () => {
  const view = (n: number, at: string, over: Record<string, unknown> = {}) =>
    ev({
      type: 'meeting.minutes_view',
      occurredAt: at,
      clientEventId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`,
      ...over,
    });
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const H = 3_600_000;

  it('keeps two views four hours apart that arrive in ONE batch (an offline browser delivering later)', async () => {
    const res = await send({ events: [view(1, ago(5 * H)), view(2, ago(1 * H))] });
    expect(await res.json()).toEqual({ accepted: 2 });
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(noteDroppedEvents).not.toHaveBeenCalledWith(expect.anything(), 'throttle', expect.anything(), expect.anything());
  });

  it('still drops a repeat less than 60 s of event time after the previous one, however late it arrives', async () => {
    const res = await send({ events: [view(1, ago(5 * H)), view(2, ago(5 * H - 30_000)), view(3, ago(1 * H))] });
    expect(await res.json()).toEqual({ accepted: 2, throttled: 1 });
    expect(noteDroppedEvents).toHaveBeenCalledWith('user-123', 'throttle', 1, expect.anything());
  });

  it('judges a batch in event order, not in the order it was sent', async () => {
    // Sent newest first; the 30 s repeat is the LATER one in event time, so that one is dropped.
    const res = await send({ events: [view(2, ago(5 * H - 30_000)), view(1, ago(5 * H))] });
    expect(await res.json()).toEqual({ accepted: 1, throttled: 1 });
    const stored = mockRecord.mock.calls[0][1] as unknown as { clientEventId: string };
    expect(stored.clientEventId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-000000000001');
  });

  it('compares with what an earlier request stored, again by event time', async () => {
    await send({ events: [view(1, ago(3 * H))] });
    expect(await (await send({ events: [view(2, ago(3 * H - 20_000))] })).json()).toEqual({ accepted: 0, throttled: 1 });
    expect(await (await send({ events: [view(3, ago(1 * H))] })).json()).toEqual({ accepted: 1 });
  });
});

describe('drops are counted and reported (audit.events_dropped)', () => {
  const batch = (n: number, off = 0) =>
    Array.from({ length: n }, (_, i) => ev({ clientEventId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(off + i).padStart(12, '0')}` }));

  it('daily cap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    alreadyStored(20000);
    await send({ events: batch(3) });
    expect(noteDroppedEvents).toHaveBeenCalledWith('user-123', 'daily_cap', 3, expect.anything());
  });

  it('rate limit', async () => {
    for (let sent = 0; sent < RATE_LIMIT_EVENTS; sent += 50) await send({ events: batch(50, sent) });
    expect((await send({ events: batch(2, 9000) })).status).toBe(429);
    expect(noteDroppedEvents).toHaveBeenCalledWith('user-123', 'rate_limit', 2, expect.anything());
  });

  it('nothing is reported when nothing was dropped', async () => {
    await send({ events: batch(2) });
    expect(noteDroppedEvents).not.toHaveBeenCalled();
  });
});

describe('events the browser lost (droppedLocally)', () => {
  const LOST_ID = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const lost = (count = 4) => ({ count, clientEventId: LOST_ID });

  it('records one audit.events_dropped (client_outbox) next to the events, as a self-reported client event', async () => {
    const res = await send({ events: [ev()], droppedLocally: lost() });
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockRecord.mock.calls[1][1]).toMatchObject({
      type: 'audit.events_dropped',
      source: 'client',
      actorUserId: 'user-123',
      clientEventId: LOST_ID,
      details: { reason: 'client_outbox', count: 4 },
    });
    expect(validateEvent(mockRecord.mock.calls[1][1] as never)).toMatchObject({ ok: true });
  });

  it('a batch may carry only the report', async () => {
    const res = await send({ events: [], droppedLocally: lost(2) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 0 });
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('is exempt from the daily cap and the throttle (it says that events are missing)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    alreadyStored(20000);
    const res = await send({ events: [ev()], droppedLocally: lost() });
    expect(await res.json()).toMatchObject({ accepted: 0, capped: true });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][1]).toMatchObject({ type: 'audit.events_dropped' });
  });

  it('stays strict: no extra keys, count must be a positive integer, id a uuid, and nothing else is accepted as a type', async () => {
    for (const bad of [
      { count: 0, clientEventId: LOST_ID },
      { count: 1.5, clientEventId: LOST_ID },
      { count: 4, clientEventId: 'not-a-uuid' },
      { count: 4, clientEventId: LOST_ID, reason: 'daily_cap' },
      { count: 4, clientEventId: LOST_ID, details: { x: 1 } },
    ]) {
      expect((await send({ events: [ev()], droppedLocally: bad })).status).toBe(400);
    }
    expect((await send({ events: [ev({ type: 'audit.events_dropped', details: { reason: 'client_outbox', count: 1 } })] })).status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('answers 503 when the report cannot be stored, so the browser keeps it', async () => {
    mockRecord.mockResolvedValueOnce({ status: 'stored' }).mockResolvedValueOnce({ status: 'dropped', code: 'db_error' });
    expect((await send({ events: [ev()], droppedLocally: lost() })).status).toBe(503);
  });
});

describe('an event type this server does not know (rolling deploy)', () => {
  it('answers 400 with a code the browser reads as "try again later", and stores nothing', async () => {
    const res = await send({ events: [ev(), ev({ type: 'meeting.something_new', clientEventId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' })] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request', code: 'unknown_event_type' });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('a malformed event is still a plain 400 without that code', async () => {
    const res = await send({ events: [ev({ details: { x: 1 } })] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request' });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner } from '@/test/fake-runner';
import {
  clampClientTime,
  clientEventsBody,
  RATE_LIMIT_EVENTS,
  RATE_LIMIT_WINDOW_MS,
  takeClientEventBudget,
  countRecentClientEvents,
  remainingClientEventsToday,
  __resetClientEventBudgets,
} from './client-ingest';

const NOW = new Date('2026-10-05T12:00:00.000Z');

describe('clampClientTime', () => {
  it('keeps times inside [now - 7 days, now + 5 minutes]', () => {
    expect(clampClientTime('2026-10-05T11:00:00.000Z', NOW).toISOString()).toBe('2026-10-05T11:00:00.000Z');
    expect(clampClientTime('2026-09-28T12:00:01.000Z', NOW).toISOString()).toBe('2026-09-28T12:00:01.000Z');
    expect(clampClientTime('2026-10-05T12:04:59.000Z', NOW).toISOString()).toBe('2026-10-05T12:04:59.000Z');
  });
  it('replaces anything outside, or unparseable, with the given server time', () => {
    expect(clampClientTime('2026-09-28T11:59:59.000Z', NOW)).toBe(NOW);
    expect(clampClientTime('2026-10-05T12:05:01.000Z', NOW)).toBe(NOW);
    expect(clampClientTime('garbage', NOW)).toBe(NOW);
  });
});

describe('clientEventsBody', () => {
  it('lists exactly the meeting.* types', () => {
    const shape = clientEventsBody.shape.events.element.shape.type;
    expect([...shape.options].sort()).toEqual(
      [
        'meeting.audio_delete',
        'meeting.audio_play',
        'meeting.delete',
        'meeting.minutes_save',
        'meeting.minutes_version',
        'meeting.minutes_version_prune',
        'meeting.metadata_edit',
        'meeting.minutes_view',
        'meeting.recording_pause',
        'meeting.recording_resume',
        'meeting.recording_start',
        'meeting.recording_stop',
        'meeting.transcript_delete',
        'meeting.transcript_edit',
        'meeting.transcript_view',
      ].sort(),
    );
  });
});

describe('clientEventsBody outcome', () => {
  const base = {
    clientEventId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    occurredAt: '2026-10-05T12:00:00.000Z',
    type: 'meeting.delete',
    entityId: '11111111-2222-4333-8444-555555555555',
  };
  const parse = (extra: Record<string, unknown>) => clientEventsBody.safeParse({ events: [{ ...base, ...extra }] });

  it('accepts success and error, and no outcome at all', () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ outcome: 'success' }).success).toBe(true);
    expect(parse({ outcome: 'error' }).success).toBe(true);
  });

  it('refuses denied and anything else: a local action cannot be denied, and no free text gets in', () => {
    for (const outcome of ['denied', 'ok', '', 1, null, { a: 1 }]) expect(parse({ outcome }).success).toBe(false);
  });
});

describe('takeClientEventBudget', () => {
  it('allows up to the limit per window, then returns seconds to wait, then resets', () => {
    __resetClientEventBudgets();
    expect(takeClientEventBudget('u', RATE_LIMIT_EVENTS, 1000)).toBeNull();
    expect(takeClientEventBudget('u', 1, 2000)).toBe(59);
    expect(takeClientEventBudget('other', 1, 2000)).toBeNull();
    expect(takeClientEventBudget('u', 1, 1000 + RATE_LIMIT_WINDOW_MS)).toBeNull();
  });
});

describe('countRecentClientEvents / remainingClientEventsToday', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('runs one schema-qualified bounded query on the actor index columns', async () => {
    const { runner, calls } = makeFakeRunner(() => [{ n: '12' }]);
    expect(await countRecentClientEvents('u1', 2000, runner)).toBe(12);
    expect(calls).toHaveLength(1);
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('public.audit_events');
    expect(sql).toContain('actor_user_id = $1');
    expect(sql).toContain("source = 'client'");
    expect(sql).toContain("interval '24 hours'");
    expect(sql).toContain('LIMIT $2');
    expect(calls[0].params).toEqual(['u1', 2000]);
  });

  it('throws on a failed or unreadable count', async () => {
    const failing = makeFakeRunner(() => {
      throw new Error('boom');
    });
    await expect(countRecentClientEvents('u', 5, failing.runner)).rejects.toThrow('boom');
    const empty = makeFakeRunner(() => []);
    await expect(countRecentClientEvents('u', 5, empty.runner)).rejects.toThrow();
  });

  it('remaining = cap - used, never negative, default cap 20000', async () => {
    expect(await remainingClientEventsToday('u', makeFakeRunner(() => [{ n: 0 }]).runner)).toBe(20000);
    expect(await remainingClientEventsToday('u', makeFakeRunner(() => [{ n: 19999 }]).runner)).toBe(1);
    expect(await remainingClientEventsToday('u', makeFakeRunner(() => [{ n: 20000 }]).runner)).toBe(0);
    expect(await remainingClientEventsToday('u', makeFakeRunner(() => [{ n: 25000 }]).runner)).toBe(0);
    vi.stubEnv('AUDIT_CLIENT_EVENTS_DAILY_CAP', '100');
    expect(await remainingClientEventsToday('u', makeFakeRunner(() => [{ n: 40 }]).runner)).toBe(60);
  });
});

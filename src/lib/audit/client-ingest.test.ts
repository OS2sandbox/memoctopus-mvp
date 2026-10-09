import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner } from '@/test/fake-runner';
import {
  clampClientTime,
  clientEventsBody,
  RATE_LIMIT_EVENTS,
  RATE_LIMIT_WINDOW_MS,
  takeClientEventBudget,
  countRecentClientEvents,
  remainingClientEventsToday,
  isClientEventThrottled,
  markClientEventStored,
  THROTTLE_WINDOW_MS,
  THROTTLE_MAX_ENTRIES,
  THROTTLED_TYPES,
  __resetClientEventBudgets,
  __throttleSize,
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
        'meeting.create',
        'meeting.delete',
        'meeting.minutes_save',
        'meeting.minutes_version',
        'meeting.minutes_version_prune',
        'meeting.metadata_edit',
        'meeting.minutes_view',
        'meeting.participants_edit',
        'meeting.recording_pause',
        'meeting.recording_resume',
        'meeting.recording_start',
        'meeting.recording_stop',
        'meeting.redact',
        'meeting.speakers_edit',
        'meeting.transcript_edit',
        'meeting.transcript_view',
      ].sort(),
    );
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

describe('client event throttle', () => {
  const M = '11111111-2222-4333-8444-555555555555';
  const T0 = 1_000_000;

  // Only the repeatable "look" events are throttled; edits, versions, recordings and
  // deletes are distinct actions and never are. meeting.create is listed for the
  // duration of the generic tests below.
  it('throttles only views and playback by default', () => {
    expect([...THROTTLED_TYPES].sort()).toEqual(['meeting.audio_play', 'meeting.minutes_view', 'meeting.transcript_view']);
    __resetClientEventBudgets();
    for (const type of ['meeting.minutes_save', 'meeting.minutes_version', 'meeting.recording_start', 'meeting.delete']) {
      markClientEventStored('u', M, type, T0, T0);
      expect(isClientEventThrottled('u', M, type, T0 + 1)).toBe(false);
    }
    markClientEventStored('u', M, 'meeting.minutes_view', T0, T0);
    expect(isClientEventThrottled('u', M, 'meeting.minutes_view', T0 + 1)).toBe(true);
    expect(isClientEventThrottled('u', M, 'meeting.minutes_view', T0 + 60_001)).toBe(false);
    expect(__throttleSize()).toBe(1);
  });

  describe('with meeting.create listed', () => {
    beforeEach(() => void THROTTLED_TYPES.add('meeting.create'));
    afterEach(() => void THROTTLED_TYPES.delete('meeting.create'));

    it('is not throttled until something was stored, then for 60 s, then free again', () => {
      __resetClientEventBudgets();
      expect(isClientEventThrottled('u', M, 'meeting.create', T0)).toBe(false);
      markClientEventStored('u', M, 'meeting.create', T0, T0);
      expect(isClientEventThrottled('u', M, 'meeting.create', T0 + 1)).toBe(true);
      expect(isClientEventThrottled('u', M, 'meeting.create', T0 + THROTTLE_WINDOW_MS - 1)).toBe(true);
      expect(isClientEventThrottled('u', M, 'meeting.create', T0 + THROTTLE_WINDOW_MS)).toBe(false);
    });

    it('is keyed on actor, meeting and type', () => {
      __resetClientEventBudgets();
      markClientEventStored('u', M, 'meeting.create', T0, T0);
      expect(isClientEventThrottled('v', M, 'meeting.create', T0)).toBe(false);
      expect(isClientEventThrottled('u', 'other', 'meeting.create', T0)).toBe(false);
      expect(isClientEventThrottled('u', M, 'meeting.redact', T0)).toBe(false);
    });

    it('never tracks or throttles other types', () => {
      __resetClientEventBudgets();
      markClientEventStored('u', M, 'meeting.delete', T0, T0);
      expect(__throttleSize()).toBe(0);
      expect(isClientEventThrottled('u', M, 'meeting.delete', T0)).toBe(false);
    });

    it('is bounded: expired entries are evicted first when the map overflows', () => {
      __resetClientEventBudgets();
      for (let i = 0; i < THROTTLE_MAX_ENTRIES; i++) markClientEventStored(`old${i}`, M, 'meeting.create', T0, T0);
      expect(__throttleSize()).toBe(THROTTLE_MAX_ENTRIES);
      markClientEventStored('fresh', M, 'meeting.create', T0 + THROTTLE_WINDOW_MS + 1, T0 + THROTTLE_WINDOW_MS + 1);
      expect(__throttleSize()).toBe(1);
      expect(isClientEventThrottled('fresh', M, 'meeting.create', T0 + THROTTLE_WINDOW_MS + 2)).toBe(true);
    });

    it('is bounded even when every entry is live: the oldest are dropped', () => {
      __resetClientEventBudgets();
      for (let i = 0; i < THROTTLE_MAX_ENTRIES + 10; i++) markClientEventStored(`u${i}`, M, 'meeting.create', T0 + i, T0 + i);
      expect(__throttleSize()).toBe(THROTTLE_MAX_ENTRIES);
      const now = T0 + THROTTLE_MAX_ENTRIES + 10;
      expect(isClientEventThrottled('u0', M, 'meeting.create', now)).toBe(false);
      expect(isClientEventThrottled(`u${THROTTLE_MAX_ENTRIES + 9}`, M, 'meeting.create', now)).toBe(true);
    });

    it('measures the minute in EVENT time: two views hours apart are both kept, a late older one inside the minute is not', () => {
      __resetClientEventBudgets();
      const H = 3_600_000;
      expect(isClientEventThrottled('u', M, 'meeting.create', T0)).toBe(false);
      markClientEventStored('u', M, 'meeting.create', T0);
      // Delivered right now, but it happened four hours later: not a repeat.
      expect(isClientEventThrottled('u', M, 'meeting.create', T0 + 4 * H)).toBe(false);
      markClientEventStored('u', M, 'meeting.create', T0 + 4 * H);
      expect(isClientEventThrottled('u', M, 'meeting.create', T0 + 4 * H + 30_000)).toBe(true);
      expect(isClientEventThrottled('u', M, 'meeting.create', T0 + 4 * H - 30_000)).toBe(true);
      expect(isClientEventThrottled('u', M, 'meeting.create', T0 + 4 * H - 61_000)).toBe(false);
    });

    it('re-marking refreshes the window and the entry age', () => {
      __resetClientEventBudgets();
      markClientEventStored('u', M, 'meeting.create', T0, T0);
      markClientEventStored('u', M, 'meeting.create', T0 + 50_000, T0 + 50_000);
      expect(isClientEventThrottled('u', M, 'meeting.create', T0 + 100_000)).toBe(true);
    });
  });
});

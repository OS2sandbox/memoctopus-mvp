import { describe, expect, it } from 'vitest';
import {
  clampClientTime,
  clientEventsBody,
  RATE_LIMIT_EVENTS,
  RATE_LIMIT_WINDOW_MS,
  takeClientEventBudget,
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
        'meeting.create',
        'meeting.delete',
        'meeting.minutes_save',
        'meeting.minutes_version',
        'meeting.participants_edit',
        'meeting.redact',
        'meeting.rename',
        'meeting.status_change',
        'meeting.transcript_edit',
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

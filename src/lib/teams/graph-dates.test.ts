import { describe, it, expect } from 'vitest';
import { graphDate, realDate } from './graph-dates';

// The value that started this: Microsoft Graph returns 0001-01-01T00:00:00Z for
// an onlineMeeting with no schedule rather than omitting the field, so every
// instant ("Mød nu") meeting carries it. It parses, so `?? null` lets it through.
const GRAPH_ZERO = '0001-01-01T00:00:00Z';

describe('graphDate', () => {
  it('keeps a real scheduled time', () => {
    expect(graphDate('2026-09-18T10:55:03.818Z')).toBe('2026-09-18T10:55:03.818Z');
  });

  it('drops the zero value Graph sends for an unscheduled meeting', () => {
    expect(graphDate(GRAPH_ZERO)).toBeNull();
  });

  it('drops missing, empty and unparseable values', () => {
    expect(graphDate(null)).toBeNull();
    expect(graphDate(undefined)).toBeNull();
    expect(graphDate('   ')).toBeNull();
    expect(graphDate('not a date')).toBeNull();
  });
});

describe('realDate', () => {
  it('keeps a real stored date', () => {
    const d = new Date('2026-09-18T10:55:03.818Z');
    expect(realDate(d)).toBe(d);
  });

  // Rows written before the resolver filtered the sentinel still hold it, so the
  // read path has to cope without a migration.
  it('drops a stored zero value', () => {
    expect(realDate(new Date(GRAPH_ZERO))).toBeNull();
  });

  it('drops null and undefined', () => {
    expect(realDate(null)).toBeNull();
    expect(realDate(undefined)).toBeNull();
  });

  // The cutoff has to sit above the unix epoch too: a 1970 timestamp is the other
  // way a "missing" date shows up, and is never a real Teams meeting.
  it('drops the unix epoch', () => {
    expect(realDate(new Date(0))).toBeNull();
  });
});

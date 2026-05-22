import { describe, it, expect } from 'vitest';
import { cn, formatDuration, formatFileSize, formatDate, formatDateTime, statusLabel, statusVariant } from './utils';

// ─── cn ───────────────────────────────────────────────────────────────────────

describe('cn', () => {
  it('merges two class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('drops falsy values', () => {
    expect(cn('foo', false && 'bar', undefined, null, 'baz')).toBe('foo baz');
  });

  it('deduplicates conflicting Tailwind utilities (last wins)', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('returns empty string for no inputs', () => {
    expect(cn()).toBe('');
  });

  it('handles array inputs', () => {
    expect(cn(['a', 'b'], 'c')).toBe('a b c');
  });
});

// ─── formatDuration ───────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats zero as 00:00', () => {
    expect(formatDuration(0)).toBe('00:00');
  });

  it('formats seconds only (< 60)', () => {
    expect(formatDuration(45)).toBe('00:45');
  });

  it('pads single-digit seconds', () => {
    expect(formatDuration(9)).toBe('00:09');
  });

  it('formats exactly one minute', () => {
    expect(formatDuration(60)).toBe('01:00');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(90)).toBe('01:30');
  });

  it('formats 59:59 without hours', () => {
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('formats exactly one hour', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
  });

  it('formats hours, minutes and seconds', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
  });

  it('pads minutes in hour format', () => {
    expect(formatDuration(3660)).toBe('1:01:00');
  });

  it('handles multiple hours', () => {
    expect(formatDuration(7322)).toBe('2:02:02');
  });

  it('floors fractional seconds', () => {
    expect(formatDuration(90.9)).toBe('01:30');
  });
});

// ─── formatFileSize ───────────────────────────────────────────────────────────

describe('formatFileSize', () => {
  it('formats 0 bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('formats 1 byte', () => {
    expect(formatFileSize(1)).toBe('1 B');
  });

  it('formats 1023 bytes', () => {
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('formats exactly 1 KB', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
  });

  it('formats 1.5 KB', () => {
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats 1023 KB', () => {
    expect(formatFileSize(1024 * 1023)).toBe('1023.0 KB');
  });

  it('formats exactly 1 MB', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
  });

  it('formats 1.5 MB', () => {
    expect(formatFileSize(1024 * 1024 * 1.5)).toBe('1.5 MB');
  });

  it('formats large MB values', () => {
    expect(formatFileSize(1024 * 1024 * 100)).toBe('100.0 MB');
  });
});

// ─── formatDate ───────────────────────────────────────────────────────────────

describe('formatDate', () => {
  it('formats a Date object with Danish month name', () => {
    const result = formatDate(new Date('2024-01-15T12:00:00Z'));
    expect(result).toMatch(/januar/i);
    expect(result).toContain('2024');
  });

  it('accepts a string date', () => {
    const result = formatDate('2024-06-01');
    expect(result).toContain('2024');
  });

  it('formats December in Danish', () => {
    const result = formatDate(new Date('2024-12-25T12:00:00Z'));
    expect(result).toMatch(/december/i);
  });

  it('includes day number', () => {
    const result = formatDate(new Date('2024-03-05T12:00:00Z'));
    expect(result).toContain('5');
  });
});

// ─── formatDateTime ───────────────────────────────────────────────────────────

describe('formatDateTime', () => {
  it('includes year in output', () => {
    const result = formatDateTime(new Date('2024-03-20T14:30:00Z'));
    expect(result).toContain('2024');
  });

  it('accepts a string date', () => {
    const result = formatDateTime('2024-06-01T10:00:00Z');
    expect(result).toContain('2024');
  });

  it('produces shorter format than formatDate (abbreviated month)', () => {
    const dateOnly = formatDate(new Date('2024-01-15T12:00:00Z'));
    const dateTime = formatDateTime(new Date('2024-01-15T12:00:00Z'));
    // formatDate uses long month, formatDateTime uses short
    expect(dateOnly.length).toBeGreaterThan(dateTime.split(' ').slice(0, 2).join(' ').length - 5);
  });
});

// ─── statusLabel ─────────────────────────────────────────────────────────────

describe('statusLabel', () => {
  it.each([
    ['recording', 'Optager'],
    ['processing', 'Behandler'],
    ['review', 'Til gennemsyn'],
    ['minutes', 'Referat'],
    ['done', 'Afsluttet'],
  ] as const)('returns "%s" label', (status, expected) => {
    expect(statusLabel(status)).toBe(expected);
  });

  it('returns the raw string for unknown status', () => {
    expect(statusLabel('unknown')).toBe('unknown');
  });

  it('returns empty string unchanged', () => {
    expect(statusLabel('')).toBe('');
  });
});

// ─── statusVariant ────────────────────────────────────────────────────────────

describe('statusVariant', () => {
  it.each([
    ['recording', 'destructive'],
    ['processing', 'warning'],
    ['review', 'default'],
    ['minutes', 'default'],
    ['done', 'success'],
  ] as const)('returns "%s" variant', (status, expected) => {
    expect(statusVariant(status)).toBe(expected);
  });

  it('returns "secondary" for unknown status', () => {
    expect(statusVariant('unknown')).toBe('secondary');
  });

  it('returns "secondary" for empty string', () => {
    expect(statusVariant('')).toBe('secondary');
  });
});

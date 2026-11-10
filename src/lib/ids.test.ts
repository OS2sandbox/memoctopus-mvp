import { describe, it, expect } from 'vitest';
import { asEntityUuid, isUuid } from './ids';

const UUID = '11111111-2222-4333-8444-555555555555';

describe('asEntityUuid', () => {
  it('accepts a well-formed UUID', () => {
    expect(asEntityUuid(UUID)).toBe(UUID);
  });

  it.each(['meet-1', '', ' ', UUID + 'x', `${UUID}\n`, '../../etc/passwd', 'Referat om sag 42'])(
    'rejects %j so arbitrary client strings never become an entity id',
    (v) => expect(asEntityUuid(v)).toBeUndefined(),
  );

  it('rejects non-strings', () => {
    expect(asEntityUuid(undefined)).toBeUndefined();
    expect(asEntityUuid(null)).toBeUndefined();
    expect(asEntityUuid(42)).toBeUndefined();
    expect(asEntityUuid({ toString: () => UUID })).toBeUndefined();
  });
});

describe('isUuid', () => {
  it('accepts either case and nothing else', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(UUID.toUpperCase())).toBe(true);
    expect(isUuid(` ${UUID}`)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

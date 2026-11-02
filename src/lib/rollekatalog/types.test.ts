import { describe, expect, it } from 'vitest';
import { ORG_UNIT_CONSTRAINT_TYPES, SYNC_COUNT_KEYS, emptySyncCounts, isOrgUnitConstraintType } from './types';

describe('sync contract', () => {
  it('emptySyncCounts has exactly the SYNC_COUNT_KEYS, all zero', () => {
    const counts = emptySyncCounts();
    expect(Object.keys(counts).sort()).toEqual([...SYNC_COUNT_KEYS].sort());
    expect(Object.values(counts).every((v) => v === 0)).toBe(true);
  });
  it('returns a fresh object each time', () => {
    expect(emptySyncCounts()).not.toBe(emptySyncCounts());
  });
});

describe('isOrgUnitConstraintType', () => {
  it('accepts exactly the two verified org unit entityIds', () => {
    expect(ORG_UNIT_CONSTRAINT_TYPES).toHaveLength(2);
    expect(isOrgUnitConstraintType('http://digital-identity.dk/constraints/orgunit/1')).toBe(true);
    expect(isOrgUnitConstraintType(' http://sts.kombit.dk/constraints/orgenhed/1 ')).toBe(true);
  });
  it('rejects KLE, names and uuids', () => {
    expect(isOrgUnitConstraintType('http://sts.kombit.dk/constraints/KLE/1')).toBe(false);
    expect(isOrgUnitConstraintType('Enhed')).toBe(false);
    expect(isOrgUnitConstraintType('49be31cf-a1c5-4be1-bb96-73e693cce3ef')).toBe(false);
  });
});

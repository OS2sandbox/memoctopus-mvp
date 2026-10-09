import { describe, expect, it } from 'vitest';
import { scopeKind } from './labels.da';

describe('scopeKind', () => {
  it('maps assignments to wording', () => {
    expect(scopeKind({ scopeOrgUnitUuid: null, includeDescendants: false })).toBe('global');
    expect(scopeKind({ scopeOrgUnitUuid: 'x', includeDescendants: true })).toBe('subtree');
    expect(scopeKind({ scopeOrgUnitUuid: 'x', includeDescendants: false })).toBe('unit');
  });
});

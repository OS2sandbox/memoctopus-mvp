import { describe, it, expect } from 'vitest';
import { describeAssignmentScope } from './scope-text';

describe('describeAssignmentScope', () => {
  it('describes a global assignment', () => {
    expect(describeAssignmentScope({ scopeOrgUnitUuid: null, scopeOrgUnitName: null, includeDescendants: true })).toBe(
      'Hele organisationen',
    );
  });

  it('describes a subtree assignment with the unit name', () => {
    expect(describeAssignmentScope({ scopeOrgUnitUuid: 'u', scopeOrgUnitName: 'Børn', includeDescendants: true })).toBe(
      'Børn – Denne enhed og alle underenheder',
    );
  });

  it('describes a single-unit assignment', () => {
    expect(describeAssignmentScope({ scopeOrgUnitUuid: 'u', scopeOrgUnitName: 'Børn', includeDescendants: false })).toBe(
      'Børn – Kun denne enhed',
    );
  });

  it('never shows the uuid when the name is unknown', () => {
    const text = describeAssignmentScope({ scopeOrgUnitUuid: 'secret-uuid', scopeOrgUnitName: null, includeDescendants: true });
    expect(text).toContain('Ukendt enhed');
    expect(text).not.toContain('secret-uuid');
  });
});

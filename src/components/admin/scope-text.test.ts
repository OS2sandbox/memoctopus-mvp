import { describe, it, expect } from 'vitest';
import { describeAssignmentScope, describeCapabilityScope } from './scope-text';

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

describe('describeCapabilityScope', () => {
  const names = new Map([['u1', 'Børn']]);

  it('fails closed to "no units" without a scope', () => {
    expect(describeCapabilityScope(undefined, names)).toBe('Ingen enheder');
    expect(describeCapabilityScope({ global: false, roots: [] }, names)).toBe('Ingen enheder');
  });

  it('describes global scope', () => {
    expect(describeCapabilityScope({ global: true, roots: [] }, names)).toBe('Hele organisationen');
  });

  it('lists roots with their names and descendant flag', () => {
    expect(
      describeCapabilityScope(
        {
          global: false,
          roots: [
            { orgUnitUuid: 'u1', includeDescendants: true },
            { orgUnitUuid: 'u2', includeDescendants: false },
          ],
        },
        names,
      ),
    ).toBe('Børn (inkl. underenheder); Ukendt enhed (kun enheden)');
  });
});

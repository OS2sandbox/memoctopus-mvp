import { describe, expect, it } from 'vitest';
import { FAKE_PRINCIPAL_ADMIN, makePrincipal } from '@/test/helpers';
import { buildPrincipalFromAssignments } from './capabilities';
import { capabilityLabels } from './labels.da';
import { explainDenial, hasAnyCapability, hasCapability } from './permissions';
import { CAPABILITIES, type Principal, type RoleKey } from './types';

// Built through the real resolver so these tables cannot drift from the matrix.
function principalFor(role: RoleKey, disabled = false): Principal {
  return buildPrincipalFromAssignments({
    userId: 'u1',
    directoryUserUuid: 'd1',
    disabled,
    assignments: [{ roleKey: role, scopeOrgUnitUuid: null, includeDescendants: true }],
    now: new Date('2026-06-15T12:00:00Z'),
    requireRoleToLogin: true,
  });
}

describe('hasCapability', () => {
  it('denies a disabled principal even if its capability list is populated', () => {
    const p = makePrincipal({ ...FAKE_PRINCIPAL_ADMIN, disabled: true });
    for (const cap of CAPABILITIES) expect(hasCapability(p, cap)).toBe(false);
  });
});

describe('hasAnyCapability', () => {
  it('is any-of and false for an empty list', () => {
    const p = principalFor('tt-bruger');
    expect(hasAnyCapability(p, ['access.manage', 'template.use'])).toBe(true);
    expect(hasAnyCapability(p, ['access.manage', 'sync.run'])).toBe(false);
    expect(hasAnyCapability(p, [])).toBe(false);
  });
});

describe('explainDenial', () => {
  const user = principalFor('tt-bruger');

  it('returns a Danish reason naming the capability for every capability a bruger lacks', () => {
    for (const cap of CAPABILITIES) {
      const reason = explainDenial(user, cap);
      if (hasCapability(user, cap)) {
        expect(reason).toBeNull();
      } else {
        expect(reason).toContain(capabilityLabels[cap]);
        expect(reason).toMatch(/^Du har ikke rettigheden /);
      }
    }
  });

  it('pins the exact string and names the granting roles', () => {
    expect(explainDenial(user, 'directory.read')).toBe(
      'Du har ikke rettigheden »Se organisationen«. Rettigheden gives af: Skabelonansvarlig, Loglæser, Administrator.',
    );
  });

  it('says the account is disabled before anything else', () => {
    expect(explainDenial(principalFor('tt-administrator', true), 'sync.run')).toBe('Kontoen er deaktiveret');
  });

  it('is null when the capability is held', () => {
    expect(explainDenial(principalFor('tt-administrator'), 'sync.run')).toBeNull();
  });
});

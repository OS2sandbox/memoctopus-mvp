import { describe, expect, it } from 'vitest';
import { FAKE_PRINCIPAL_ADMIN, makePrincipal } from '@/test/helpers';
import { ROLE_DEFINITIONS, buildPrincipalFromAssignments } from './capabilities';
import { capabilityLabels } from './labels.da';
import {
  canExportAudit,
  canManageAccess,
  canManageTemplateInUnits,
  canReadAuditForUnit,
  canReadDirectory,
  canReadDirectoryUnit,
  canRunSync,
  canUseTemplates,
  capabilityCoversUnit,
  explainDenial,
  explainScopeDenial,
  hasAnyCapability,
  hasCapability,
  hasGlobalScope,
} from './permissions';
import { CAPABILITIES, ROLE_KEYS, type Principal, type RoleKey } from './types';

const NOW = new Date('2026-06-15T12:00:00Z');
const OU_A = 'aaaa0000-0000-4000-8000-000000000001';
const OU_B = 'bbbb0000-0000-4000-8000-000000000002';

// Built through the real resolver so these tables cannot drift from the matrix.
function principalFor(role: RoleKey, disabled = false, scope: string | null = null): Principal {
  return buildPrincipalFromAssignments({
    userId: 'u1',
    directoryUserUuid: 'd1',
    disabled,
    assignments: [{ roleKey: role, scopeOrgUnitUuid: scope, includeDescendants: true }],
    now: NOW,
    requireRoleToLogin: true,
  });
}

describe('hasCapability: role x capability x disabled', () => {
  for (const role of ROLE_KEYS) {
    for (const cap of CAPABILITIES) {
      const expected = ROLE_DEFINITIONS[role].capabilities.includes(cap);
      it(`${role} ${expected ? 'has' : 'lacks'} ${cap}`, () => {
        expect(hasCapability(principalFor(role), cap)).toBe(expected);
      });
      it(`disabled ${role} never has ${cap}`, () => {
        expect(hasCapability(principalFor(role, true), cap)).toBe(false);
      });
    }
  }

  it('denies a disabled principal even if its capability list is populated', () => {
    const p = makePrincipal({ ...FAKE_PRINCIPAL_ADMIN, disabled: true });
    for (const cap of CAPABILITIES) expect(hasCapability(p, cap)).toBe(false);
  });
});

describe('named predicates', () => {
  it('map to exactly one capability each', () => {
    const cases: Array<[(p: Principal) => boolean, (typeof CAPABILITIES)[number]]> = [
      [canUseTemplates, 'template.use'],
      [canManageAccess, 'access.manage'],
      [canReadDirectory, 'directory.read'],
      [canRunSync, 'sync.run'],
      [canExportAudit, 'audit.export'],
    ];
    for (const [fn, cap] of cases) {
      for (const role of ROLE_KEYS) {
        const p = principalFor(role);
        expect(fn(p), `${role} ${cap}`).toBe(hasCapability(p, cap));
      }
      expect(fn(principalFor('tt-administrator', true))).toBe(false);
    }
  });

  it('only the administrator manages access and runs sync', () => {
    for (const role of ROLE_KEYS) {
      const isAdmin = role === 'tt-administrator';
      expect(canManageAccess(principalFor(role))).toBe(isAdmin);
      expect(canRunSync(principalFor(role))).toBe(isAdmin);
    }
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

describe('scope-aware predicates', () => {
  const covered = new Set([OU_A]);

  it('template.manage: covered unit yes, other unit no, no owner no', () => {
    const p = principalFor('tt-skabelonansvarlig', false, OU_A);
    expect(canManageTemplateInUnits(p, OU_A, covered)).toBe(true);
    expect(canManageTemplateInUnits(p, OU_B, covered)).toBe(false);
    expect(canManageTemplateInUnits(p, null, covered)).toBe(false);
  });

  it('accepts an array as well as a set', () => {
    const p = principalFor('tt-skabelonansvarlig', false, OU_A);
    expect(canManageTemplateInUnits(p, OU_A, [OU_A])).toBe(true);
    expect(canManageTemplateInUnits(p, OU_B, [OU_A])).toBe(false);
  });

  it('fails closed for a skabelonansvarlig with NULL scope', () => {
    const p = principalFor('tt-skabelonansvarlig');
    expect(hasCapability(p, 'template.manage')).toBe(true);
    // The caller derives the covered set from the principal's roots: none here.
    expect(canManageTemplateInUnits(p, OU_A, new Set())).toBe(false);
    expect(canManageTemplateInUnits(p, null, new Set())).toBe(false);
  });

  it('a global logleser reads audit for any unit and for unit-less events', () => {
    const p = principalFor('tt-logleser');
    expect(hasGlobalScope(p, 'audit.read')).toBe(true);
    expect(canReadAuditForUnit(p, OU_B, new Set())).toBe(true);
    expect(canReadAuditForUnit(p, null, new Set())).toBe(true);
  });

  it('a scoped logleser reads only covered units, not unit-less events', () => {
    const p = principalFor('tt-logleser', false, OU_A);
    expect(hasGlobalScope(p, 'audit.read')).toBe(false);
    expect(canReadAuditForUnit(p, OU_A, covered)).toBe(true);
    expect(canReadAuditForUnit(p, OU_B, covered)).toBe(false);
    expect(canReadAuditForUnit(p, null, covered)).toBe(false);
  });

  it('a covered-unit set is useless without the capability', () => {
    const p = principalFor('tt-bruger');
    expect(canReadAuditForUnit(p, OU_A, covered)).toBe(false);
    expect(canReadDirectoryUnit(p, OU_A, covered)).toBe(false);
    expect(capabilityCoversUnit(p, 'template.manage', OU_A, covered)).toBe(false);
  });

  it('a disabled principal is denied even with global scope', () => {
    const p = { ...FAKE_PRINCIPAL_ADMIN, disabled: true };
    expect(canReadAuditForUnit(p, OU_A, covered)).toBe(false);
    expect(canManageTemplateInUnits(p, null, covered)).toBe(false);
    expect(hasGlobalScope(p, 'audit.read')).toBe(false);
  });

  it('does not treat a global scope entry as granting a capability the principal lacks', () => {
    const p = makePrincipal({ scopes: { 'audit.read': { global: true, roots: [] } } });
    expect(canReadAuditForUnit(p, OU_A, covered)).toBe(false);
  });

  it('directory.read follows the same scope rules', () => {
    const p = principalFor('tt-skabelonansvarlig', false, OU_A);
    expect(canReadDirectoryUnit(p, OU_A, covered)).toBe(true);
    expect(canReadDirectoryUnit(p, OU_B, covered)).toBe(false);
  });

  it('administrator is global on every scoped capability', () => {
    const p = principalFor('tt-administrator');
    expect(canManageTemplateInUnits(p, OU_B, new Set())).toBe(true);
    expect(canReadAuditForUnit(p, OU_B, new Set())).toBe(true);
    expect(canReadDirectoryUnit(p, OU_B, new Set())).toBe(true);
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

  it('pins the exact strings', () => {
    expect(explainDenial(user, 'access.manage')).toBe(
      'Du har ikke rettigheden »Administrere brugere og roller«. Rettigheden gives af: Administrator.',
    );
    expect(explainDenial(user, 'audit.read')).toBe(
      'Du har ikke rettigheden »Læse loggen«. Rettigheden gives af: Logleser, Administrator.',
    );
    expect(explainDenial(user, 'template.manage')).toBe(
      'Du har ikke rettigheden »Administrere skabeloner«. Rettigheden gives af: Skabelonansvarlig, Administrator.',
    );
    expect(explainDenial(user, 'directory.read')).toBe(
      'Du har ikke rettigheden »Se organisationen«. Rettigheden gives af: Skabelonansvarlig, Logleser, Administrator.',
    );
    expect(explainDenial(user, 'audit.export')).toBe(
      'Du har ikke rettigheden »Eksportere loggen«. Rettigheden gives af: Logleser, Administrator.',
    );
    expect(explainDenial(user, 'sync.run')).toBe(
      'Du har ikke rettigheden »Starte synkronisering«. Rettigheden gives af: Administrator.',
    );
  });

  it('explains a missing template.use for a principal without any role', () => {
    const none = makePrincipal({ roles: [], capabilities: [] });
    expect(explainDenial(none, 'template.use')).toContain('Bruger');
  });

  it('says the account is disabled before anything else, for every capability', () => {
    const disabled = principalFor('tt-administrator', true);
    for (const cap of CAPABILITIES) {
      expect(explainDenial(disabled, cap)).toBe('Kontoen er deaktiveret');
    }
  });

  it('is null when the capability is held', () => {
    expect(explainDenial(principalFor('tt-administrator'), 'sync.run')).toBeNull();
  });

  it('is consistent with hasCapability across role x capability', () => {
    for (const role of ROLE_KEYS) {
      for (const cap of CAPABILITIES) {
        const p = principalFor(role);
        expect(explainDenial(p, cap) === null).toBe(hasCapability(p, cap));
      }
    }
  });

  it('explainScopeDenial distinguishes a missing right from a missing scope', () => {
    expect(explainScopeDenial(user, 'audit.read')).toBe(explainDenial(user, 'audit.read'));
    const scoped = principalFor('tt-logleser', false, OU_A);
    expect(explainScopeDenial(scoped, 'audit.read')).toBe(
      'Din rettighed »Læse loggen« gælder ikke for denne enhed.',
    );
    expect(explainScopeDenial(principalFor('tt-logleser', true), 'audit.read')).toBe(
      'Kontoen er deaktiveret',
    );
  });

  it('never leaks identifiers', () => {
    const reason = explainScopeDenial(principalFor('tt-logleser', false, OU_A), 'audit.read');
    expect(reason).not.toContain(OU_A);
    expect(reason).not.toContain('u1');
  });
});

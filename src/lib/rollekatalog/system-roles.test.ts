import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_KEYS } from '@/lib/authz/types';

interface SystemRoleDef {
  identifier: string;
  name: string;
  description: string;
  weight: number;
  roleType: string;
  supportsOrgUnitConstraint: boolean;
  constraintMandatory: boolean;
}

const def = JSON.parse(readFileSync(path.join(__dirname, 'system-roles.json'), 'utf8')) as {
  itSystem: { name: string; systemtype: string; defaultIdentifier: string };
  orgUnitConstraintEntityId: string;
  systemRoles: SystemRoleDef[];
};

describe('system-roles.json', () => {
  it('has exactly the app role keys, in order', () => {
    expect(def.systemRoles.map((r) => r.identifier)).toEqual([...ROLE_KEYS]);
  });

  it('uses identifiers Rollekatalog accepts', () => {
    for (const r of def.systemRoles) expect(r.identifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('has a Danish name and description for every role', () => {
    for (const r of def.systemRoles) {
      expect(r.name.trim()).not.toBe('');
      expect(r.description.trim()).not.toBe('');
    }
  });

  it('only the scopable roles support the org-unit constraint (tt-administrator can never be scoped)', () => {
    const scoped = def.systemRoles.filter((r) => r.supportsOrgUnitConstraint).map((r) => r.identifier);
    expect(scoped).toEqual(['tt-skabelonansvarlig', 'tt-logleser']);
  });

  it('gives every role the same weight, because Rollekatalog hides roles below the highest weight', () => {
    expect(new Set(def.systemRoles.map((r) => r.weight)).size).toBe(1);
    for (const r of def.systemRoles) expect(Number.isInteger(r.weight)).toBe(true);
  });

  it('declares FUNCTION_ROLE (documentation only: SystemRoleAM cannot carry it)', () => {
    for (const r of def.systemRoles) expect(r.roleType).toBe('FUNCTION_ROLE');
  });

  it('registers a SAML system under the default identifier and the internal org-unit constraint', () => {
    expect(def.itSystem.systemtype).toBe('SAML');
    expect(def.itSystem.defaultIdentifier).toBe('os2taletiltekst');
    expect(def.orgUnitConstraintEntityId).toBe('http://digital-identity.dk/constraints/orgunit/1');
  });
});

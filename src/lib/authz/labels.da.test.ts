import { describe, expect, it } from 'vitest';
import {
  capabilityDescriptions,
  capabilityLabels,
  principalSourceLabels,
  roleDescriptions,
  roleLabels,
  scopeKind,
  scopeLabels,
  sourceLabels,
} from './labels.da';
import { CAPABILITIES, ROLE_KEYS } from './types';

const nonEmpty = (s: unknown) => typeof s === 'string' && s.trim().length > 0;

describe('Danish labels', () => {
  it('cover every role', () => {
    for (const role of ROLE_KEYS) {
      expect(nonEmpty(roleLabels[role]), role).toBe(true);
      expect(nonEmpty(roleDescriptions[role]), role).toBe(true);
    }
    expect(Object.keys(roleLabels).sort()).toEqual([...ROLE_KEYS].sort());
    expect(Object.keys(roleDescriptions).sort()).toEqual([...ROLE_KEYS].sort());
  });

  it('cover every capability', () => {
    for (const cap of CAPABILITIES) {
      expect(nonEmpty(capabilityLabels[cap]), cap).toBe(true);
      expect(nonEmpty(capabilityDescriptions[cap]), cap).toBe(true);
    }
    expect(Object.keys(capabilityLabels).sort()).toEqual([...CAPABILITIES].sort());
    expect(Object.keys(capabilityDescriptions).sort()).toEqual([...CAPABILITIES].sort());
  });

  it('pins the role names and scope wording', () => {
    expect(roleLabels).toEqual({
      'tt-bruger': 'Bruger',
      'tt-skabelonansvarlig': 'Skabelonansvarlig',
      'tt-logleser': 'Logleser',
      'tt-administrator': 'Administrator',
    });
    expect(scopeLabels).toEqual({
      global: 'Hele organisationen',
      subtree: 'Denne enhed og alle underenheder',
      unit: 'Kun denne enhed',
    });
  });

  it('labels sources', () => {
    expect(sourceLabels).toEqual({ local: 'Lokal', rollekatalog: 'Rollekatalog' });
    expect(nonEmpty(principalSourceLabels.baseline)).toBe(true);
    expect(principalSourceLabels.local).toBe('Lokal');
  });

  it('has unique role labels', () => {
    expect(new Set(Object.values(roleLabels)).size).toBe(ROLE_KEYS.length);
  });

  it('scopeKind maps assignments to wording', () => {
    expect(scopeKind({ scopeOrgUnitUuid: null, includeDescendants: false })).toBe('global');
    expect(scopeKind({ scopeOrgUnitUuid: 'x', includeDescendants: true })).toBe('subtree');
    expect(scopeKind({ scopeOrgUnitUuid: 'x', includeDescendants: false })).toBe('unit');
  });
});

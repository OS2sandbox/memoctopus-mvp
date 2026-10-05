import { describe, expect, it } from 'vitest';
import { FAKE_PRINCIPAL_ADMIN, makePrincipal } from '@/test/helpers';
import {
  ADMIN_SECTIONS,
  canAccessSection,
  sectionByKey,
  visibleSections,
  type AdminSectionKey,
} from './admin-sections';
import { buildPrincipalFromAssignments } from './capabilities';
import { CAPABILITIES, ROLE_KEYS, type RoleKey } from './types';

function principalFor(role: RoleKey, disabled = false) {
  return buildPrincipalFromAssignments({
    userId: 'u1',
    directoryUserUuid: 'd1',
    disabled,
    assignments: [{ roleKey: role, scopeOrgUnitUuid: null, includeDescendants: true }],
    now: new Date('2026-06-15T12:00:00Z'),
    requireRoleToLogin: false,
  });
}

const keysFor = (role: RoleKey, disabled = false) =>
  visibleSections(principalFor(role, disabled)).map((s) => s.key);

describe('admin sections table', () => {
  it('has exactly the four sections with their hrefs and labels', () => {
    expect(ADMIN_SECTIONS.map((s) => [s.key, s.href, s.label])).toEqual([
      ['overview', '/admin', 'Overblik'],
      ['users', '/admin/brugere', 'Brugere og roller'],
      ['organisation', '/admin/organisation', 'Organisation'],
      ['log', '/admin/log', 'Log'],
    ]);
  });

  it('sectionByKey agrees with the list', () => {
    for (const s of ADMIN_SECTIONS) expect(sectionByKey[s.key]).toBe(s);
    expect(Object.keys(sectionByKey).sort()).toEqual(ADMIN_SECTIONS.map((s) => s.key).sort());
  });

  it('never has an empty requirement and only uses known capabilities', () => {
    for (const s of ADMIN_SECTIONS) {
      expect(s.requiredCapability.length).toBeGreaterThan(0);
      for (const c of s.requiredCapability) expect(CAPABILITIES).toContain(c);
    }
  });

  it('keeps plain template.use out of the overview requirement', () => {
    expect(sectionByKey.overview.requiredCapability).not.toContain('template.use');
  });

  it('the log section is any-of audit.read and not read-only in rollekatalog mode', () => {
    expect(sectionByKey.log.requiredCapability).toEqual(['audit.read']);
    expect(sectionByKey.log.readOnlyInRollekatalogMode).toBe(false);
  });

  it('audit.export alone opens the overview but not the log', () => {
    const p = makePrincipal({ capabilities: ['template.use', 'audit.export'] });
    expect(canAccessSection(p, 'log')).toBe(false);
    expect(canAccessSection(makePrincipal({ capabilities: ['template.use', 'audit.read'] }), 'log')).toBe(true);
  });

  it('flags users and organisation read-only in rollekatalog mode', () => {
    expect(sectionByKey.overview.readOnlyInRollekatalogMode).toBe(false);
    expect(sectionByKey.users.readOnlyInRollekatalogMode).toBe(true);
    expect(sectionByKey.organisation.readOnlyInRollekatalogMode).toBe(true);
  });
});

describe('visibleSections per role (snapshot)', () => {
  it.each<[RoleKey, AdminSectionKey[]]>([
    ['tt-bruger', []],
    ['tt-skabelonansvarlig', ['overview', 'organisation']],
    ['tt-logleser', ['overview', 'organisation', 'log']],
    ['tt-administrator', ['overview', 'users', 'organisation', 'log']],
  ])('%s sees %j', (role, expected) => {
    expect(keysFor(role)).toEqual(expected);
  });

  it('covers every role', () => {
    for (const role of ROLE_KEYS) expect(Array.isArray(keysFor(role))).toBe(true);
  });

  it('shows nothing to a disabled administrator', () => {
    expect(keysFor('tt-administrator', true)).toEqual([]);
    expect(canAccessSection(principalFor('tt-administrator', true), 'overview')).toBe(false);
  });

  it('is any-of: a single admin capability opens the overview only', () => {
    const p = makePrincipal({ capabilities: ['template.use', 'audit.export'] });
    expect(visibleSections(p).map((s) => s.key)).toEqual(['overview']);
  });

  it('the route gate and the nav agree for every role and section', () => {
    for (const role of ROLE_KEYS) {
      const p = principalFor(role);
      const visible = new Set(visibleSections(p).map((s) => s.key));
      for (const s of ADMIN_SECTIONS) expect(canAccessSection(p, s.key)).toBe(visible.has(s.key));
    }
  });

  it('the hand-built admin fixture sees everything', () => {
    expect(visibleSections(FAKE_PRINCIPAL_ADMIN)).toHaveLength(4);
  });
});

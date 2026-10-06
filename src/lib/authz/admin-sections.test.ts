import { describe, expect, it } from 'vitest';
import { FAKE_PRINCIPAL_ADMIN, makePrincipal } from '@/test/helpers';
import {
  ADMIN_SECTIONS,
  canAccessSection,
  visibleSections,
  type AdminSectionKey,
} from './admin-sections';
import { buildPrincipalFromAssignments } from './capabilities';
import type { RoleKey } from './types';

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
  it('has exactly the five sections with their hrefs and labels', () => {
    expect(ADMIN_SECTIONS.map((s) => [s.key, s.href, s.label])).toEqual([
      ['overview', '/admin', 'Overblik'],
      ['users', '/admin/brugere', 'Brugere og roller'],
      ['organisation', '/admin/organisation', 'Organisation'],
      ['templates', '/admin/skabeloner', 'Centrale skabeloner'],
      ['log', '/admin/log', 'Log'],
    ]);
  });

  it('keeps plain template.use out of the overview requirement', () => {
    expect(ADMIN_SECTIONS.find((x) => x.key === 'overview')?.requiredCapability).not.toContain('template.use');
  });

  it('audit.export alone opens the overview but not the log', () => {
    const p = makePrincipal({ capabilities: ['template.use', 'audit.export'] });
    expect(canAccessSection(p, 'log')).toBe(false);
    expect(canAccessSection(makePrincipal({ capabilities: ['template.use', 'audit.read'] }), 'log')).toBe(true);
  });
});

describe('visibleSections per role (snapshot)', () => {
  it.each<[RoleKey, AdminSectionKey[]]>([
    ['tt-bruger', []],
    ['tt-skabelonansvarlig', ['overview', 'organisation', 'templates']],
    ['tt-logleser', ['overview', 'organisation', 'log']],
    ['tt-administrator', ['overview', 'users', 'organisation', 'templates', 'log']],
  ])('%s sees %j', (role, expected) => {
    expect(keysFor(role)).toEqual(expected);
  });

  it('shows nothing to a disabled administrator', () => {
    expect(keysFor('tt-administrator', true)).toEqual([]);
    expect(canAccessSection(principalFor('tt-administrator', true), 'overview')).toBe(false);
  });

  it('is any-of: a single admin capability opens the overview only', () => {
    const p = makePrincipal({ capabilities: ['template.use', 'audit.export'] });
    expect(visibleSections(p).map((s) => s.key)).toEqual(['overview']);
  });

  it('the hand-built admin fixture sees everything', () => {
    expect(visibleSections(FAKE_PRINCIPAL_ADMIN)).toHaveLength(5);
  });
});

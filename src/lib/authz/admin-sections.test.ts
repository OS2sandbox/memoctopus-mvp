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
  it('has exactly the four sections with their hrefs and labels', () => {
    expect(ADMIN_SECTIONS.map((s) => [s.key, s.href, s.label])).toEqual([
      ['users', '/admin/brugere', 'Brugere og roller'],
      ['organisation', '/admin/organisation', 'Organisation'],
      ['templates', '/admin/skabeloner', 'Centrale skabeloner'],
      ['log', '/admin/log', 'Log'],
    ]);
  });

  it('keeps plain template.use out of every section requirement', () => {
    for (const s of ADMIN_SECTIONS) expect(s.requiredCapability).not.toContain('template.use');
  });

  it('has no separate overview section (/admin only redirects)', () => {
    expect(ADMIN_SECTIONS.some((s) => s.href === '/admin')).toBe(false);
  });

  it('audit.export alone opens no section, and audit.read opens the log', () => {
    const p = makePrincipal({ capabilities: ['template.use', 'audit.export'] });
    expect(canAccessSection(p, 'log')).toBe(false);
    expect(visibleSections(p)).toEqual([]);
    expect(canAccessSection(makePrincipal({ capabilities: ['template.use', 'audit.read'] }), 'log')).toBe(true);
  });
});

describe('visibleSections per role (snapshot)', () => {
  it.each<[RoleKey, AdminSectionKey[]]>([
    ['bruger', []],
    ['bygger', ['organisation', 'templates']],
    ['admin', ['users', 'organisation', 'templates', 'log']],
  ])('%s sees %j', (role, expected) => {
    expect(keysFor(role)).toEqual(expected);
  });

  it('shows nothing to a disabled administrator', () => {
    expect(keysFor('admin', true)).toEqual([]);
    expect(canAccessSection(principalFor('admin', true), 'users')).toBe(false);
  });

  it('is any-of: a single admin capability opens exactly its own section', () => {
    expect(visibleSections(makePrincipal({ capabilities: ['template.use', 'template.manage'] })).map((s) => s.key)).toEqual([
      'templates',
    ]);
    expect(visibleSections(makePrincipal({ capabilities: ['template.use', 'audit.read'] })).map((s) => s.key)).toEqual(['log']);
  });

  it('the hand-built admin fixture sees everything', () => {
    expect(visibleSections(FAKE_PRINCIPAL_ADMIN)).toHaveLength(4);
  });
});

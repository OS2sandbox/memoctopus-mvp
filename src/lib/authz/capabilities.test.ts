import { describe, expect, it } from 'vitest';
import {
  GLOBAL_ONLY_CAPABILITIES,
  ROLE_DEFINITIONS,
  SCOPED_CAPABILITIES,
  buildPrincipalFromAssignments,
} from './capabilities';
import { CAPABILITIES, ROLE_KEYS, type RoleAssignmentRow } from './types';

const NOW = new Date('2026-06-15T12:00:00Z');
const OU_A = 'aaaa0000-0000-4000-8000-000000000001';
const OU_B = 'bbbb0000-0000-4000-8000-000000000002';

function build(
  assignments: Array<Partial<RoleAssignmentRow> & { roleKey: string }>,
  opts: { requireRoleToLogin?: boolean; disabled?: boolean } = {},
) {
  return buildPrincipalFromAssignments({
    userId: 'u1',
    directoryUserUuid: 'd1',
    disabled: opts.disabled ?? false,
    assignments: assignments.map((a) => ({
      scopeOrgUnitUuid: null,
      includeDescendants: true,
      ...a,
    })),
    now: NOW,
    requireRoleToLogin: opts.requireRoleToLogin ?? false,
  });
}

describe('role matrix tripwire', () => {
  // Pinned as literals on purpose: changing the matrix must be a conscious edit here too.
  it('pins roles, capabilities and scoped capabilities', () => {
    expect([...ROLE_KEYS]).toEqual([
      'tt-bruger',
      'tt-skabelonansvarlig',
      'tt-logleser',
      'tt-administrator',
    ]);
    expect([...CAPABILITIES]).toEqual([
      'template.use',
      'template.manage',
      'audit.read',
      'audit.export',
      'directory.read',
      'access.manage',
      'sync.run',
    ]);
    expect([...GLOBAL_ONLY_CAPABILITIES].sort()).toEqual(['access.manage', 'audit.export', 'sync.run']);
    expect([...SCOPED_CAPABILITIES].sort()).toEqual(['audit.read', 'directory.read', 'template.manage']);
  });

  it('pins the full role -> capabilities matrix', () => {
    expect(ROLE_DEFINITIONS).toEqual({
      'tt-bruger': { capabilities: ['template.use'], globalScopeAllowed: false },
      'tt-skabelonansvarlig': {
        capabilities: ['template.use', 'template.manage', 'directory.read'],
        globalScopeAllowed: false,
      },
      'tt-logleser': {
        capabilities: ['template.use', 'audit.read', 'audit.export', 'directory.read'],
        globalScopeAllowed: true,
      },
      'tt-administrator': {
        capabilities: [
          'template.use',
          'template.manage',
          'audit.read',
          'audit.export',
          'directory.read',
          'access.manage',
          'sync.run',
        ],
        globalScopeAllowed: true,
      },
    });
  });
});

describe('buildPrincipalFromAssignments', () => {
  it('gives an assignment-less user the tt-bruger baseline when roles are not required', () => {
    const p = build([]);
    expect(p.roles).toEqual(['tt-bruger']);
    expect(p.capabilities).toEqual(['template.use']);
    expect(p.source).toBe('baseline');
    expect(p.scopes).toEqual({});
  });

  it('gives an assignment-less user nothing when requireRoleToLogin is true', () => {
    const p = build([], { requireRoleToLogin: true });
    expect(p.roles).toEqual([]);
    expect(p.capabilities).toEqual([]);
  });

  it('does not add the baseline when requireRoleToLogin is true, but honours explicit tt-bruger', () => {
    const p = build([{ roleKey: 'tt-bruger' }], { requireRoleToLogin: true });
    expect(p.roles).toEqual(['tt-bruger']);
    expect(p.capabilities).toEqual(['template.use']);
  });

  it('fails closed: tt-skabelonansvarlig with NULL scope covers no org unit', () => {
    const p = build([{ roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: null }]);
    expect(p.capabilities).toContain('template.manage');
    expect(p.scopes['template.manage']).toEqual({ global: false, roots: [] });
    expect(p.scopes['directory.read']).toEqual({ global: false, roots: [] });
  });

  it('scopes tt-skabelonansvarlig to its org unit', () => {
    const p = build([
      { roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: OU_A, includeDescendants: false },
    ]);
    expect(p.scopes['template.manage']).toEqual({
      global: false,
      roots: [{ orgUnitUuid: OU_A, includeDescendants: false }],
    });
  });

  it('treats NULL scope as global for tt-logleser and tt-administrator', () => {
    const logleser = build([{ roleKey: 'tt-logleser' }]);
    expect(logleser.scopes['audit.read']?.global).toBe(true);
    expect(logleser.capabilities).toEqual(
      expect.arrayContaining(['audit.read', 'audit.export', 'directory.read']),
    );
    expect(logleser.capabilities).not.toContain('template.manage');

    const admin = build([{ roleKey: 'tt-administrator' }]);
    expect(admin.capabilities).toEqual([...CAPABILITIES]);
    expect(admin.scopes['template.manage']?.global).toBe(true);
    expect(admin.scopes['audit.read']?.global).toBe(true);
    expect(admin.scopes['directory.read']?.global).toBe(true);
  });

  it('a unit-scoped tt-administrator gets NO global-only capability (no self-promotion to global admin)', () => {
    const p = build([{ roleKey: 'tt-administrator', scopeOrgUnitUuid: OU_A }]);
    expect(p.capabilities).not.toContain('access.manage');
    expect(p.capabilities).not.toContain('sync.run');
    expect(p.capabilities).not.toContain('audit.export');
    expect(p.scopes['audit.read']?.roots).toEqual([{ orgUnitUuid: OU_A, includeDescendants: true }]);
    expect(p.scopes['audit.read']?.global).toBe(false);
  });

  it('a unit-scoped tt-logleser can read its unit but not export the whole log', () => {
    const p = build([{ roleKey: 'tt-logleser', scopeOrgUnitUuid: OU_A }]);
    expect(p.capabilities).toContain('audit.read');
    expect(p.capabilities).not.toContain('audit.export');
  });

  it('a global grant elsewhere still unlocks the global-only capabilities', () => {
    const p = build([{ roleKey: 'tt-logleser', scopeOrgUnitUuid: OU_A }, { roleKey: 'tt-logleser' }]);
    expect(p.capabilities).toContain('audit.export');
  });

  it('a NULL-scoped tt-skabelonansvarlig is not global, so contributes no global-only capability', () => {
    expect(GLOBAL_ONLY_CAPABILITIES.has('audit.export')).toBe(true);
    const p = build([{ roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: null }]);
    expect(p.capabilities).not.toContain('audit.export');
  });

  it('keeps template.use for a scoped role when REQUIRE_ROLE_TO_LOGIN removes the baseline', () => {
    const p = build([{ roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: OU_A }], { requireRoleToLogin: true });
    expect(p.capabilities).toContain('template.use');
  });

  it('does not give non-scoped capabilities a scope entry', () => {
    const admin = build([{ roleKey: 'tt-administrator' }]);
    expect(admin.scopes['access.manage']).toBeUndefined();
    expect(admin.scopes['sync.run']).toBeUndefined();
    expect(admin.scopes['audit.export']).toBeUndefined();
    expect(admin.scopes['template.use']).toBeUndefined();
  });

  it('ignores expired and not-yet-started assignments', () => {
    const p = build([
      { roleKey: 'tt-administrator', stopDate: new Date('2026-06-01T00:00:00Z') },
      { roleKey: 'tt-logleser', startDate: new Date('2026-07-01T00:00:00Z') },
    ]);
    expect(p.roles).toEqual(['tt-bruger']);
    expect(p.capabilities).toEqual(['template.use']);
    expect(p.scopes).toEqual({});
  });

  it('uses a half-open interval: active at startDate, over at stopDate', () => {
    expect(build([{ roleKey: 'tt-administrator', startDate: NOW }]).roles).toContain('tt-administrator');
    expect(build([{ roleKey: 'tt-administrator', stopDate: NOW }]).roles).not.toContain(
      'tt-administrator',
    );
  });

  it('gives a disabled user nothing, even with assignments', () => {
    const p = build([{ roleKey: 'tt-administrator' }], { disabled: true });
    expect(p.disabled).toBe(true);
    expect(p.roles).toEqual([]);
    expect(p.capabilities).toEqual([]);
    expect(p.scopes).toEqual({});
  });

  it('merges duplicate and overlapping scopes without duplicates', () => {
    const p = build([
      { roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: OU_A, includeDescendants: false },
      { roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: OU_A, includeDescendants: true },
      { roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: OU_B, includeDescendants: false },
      { roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: OU_B, includeDescendants: false },
    ]);
    expect(p.scopes['template.manage']?.roots).toEqual([
      { orgUnitUuid: OU_A, includeDescendants: true },
      { orgUnitUuid: OU_B, includeDescendants: false },
    ]);
    expect(p.roles).toEqual(['tt-bruger', 'tt-skabelonansvarlig']);
    expect(new Set(p.capabilities).size).toBe(p.capabilities.length);
  });

  it('merges a global grant with unit grants from different roles', () => {
    const p = build([
      { roleKey: 'tt-logleser' },
      { roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: OU_A },
    ]);
    expect(p.scopes['directory.read']).toEqual({
      global: true,
      roots: [{ orgUnitUuid: OU_A, includeDescendants: true }],
    });
    expect(p.scopes['template.manage']?.global).toBe(false);
  });

  it('ignores unknown role keys', () => {
    const p = build([{ roleKey: 'tt-superman' }, { roleKey: '' }, { roleKey: 'TT-ADMINISTRATOR' }]);
    expect(p.roles).toEqual(['tt-bruger']);
    expect(p.capabilities).toEqual(['template.use']);
  });

  it('carries identity through unchanged', () => {
    const p = build([]);
    expect(p.userId).toBe('u1');
    expect(p.directoryUserUuid).toBe('d1');
  });
});

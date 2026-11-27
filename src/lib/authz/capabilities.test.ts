import { describe, expect, it } from 'vitest';
import {
  GLOBAL_ONLY_CAPABILITIES,
  ROLE_DEFINITIONS,
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
  it('pins roles, capabilities and the global-only capabilities', () => {
    expect([...ROLE_KEYS]).toEqual([
      'bruger',
      'bygger',
      'admin',
    ]);
    expect([...CAPABILITIES]).toEqual([
      'template.use',
      'template.manage',
      'template.manage_all',
      'audit.read',
      'audit.export',
      'access.manage',
      'sync.run',
    ]);
    expect([...GLOBAL_ONLY_CAPABILITIES].sort()).toEqual([
      'access.manage',
      'audit.export',
      'audit.read',
      'sync.run',
      'template.manage_all',
    ]);
  });

  it('pins the full role -> capabilities matrix', () => {
    expect(ROLE_DEFINITIONS).toEqual({
      'bruger': { capabilities: ['template.use'], scope: 'none' },
      'bygger': {
        capabilities: ['template.use', 'template.manage'],
        scope: 'none',
      },
      'admin': {
        capabilities: [
          'template.use',
          'template.manage',
          'template.manage_all',
          'audit.read',
          'audit.export',
          'access.manage',
          'sync.run',
        ],
        scope: 'global-only',
      },
    });
  });
});

describe('buildPrincipalFromAssignments', () => {
  it('gives an assignment-less user the bruger baseline when roles are not required', () => {
    const p = build([]);
    expect(p.roles).toEqual(['bruger']);
    expect(p.capabilities).toEqual(['template.use']);
    expect(p.source).toBe('baseline');
  });

  it('gives an assignment-less user nothing when requireRoleToLogin is true', () => {
    const p = build([], { requireRoleToLogin: true });
    expect(p.roles).toEqual([]);
    expect(p.capabilities).toEqual([]);
  });

  it('does not add the baseline when requireRoleToLogin is true, but honours explicit bruger', () => {
    const p = build([{ roleKey: 'bruger' }], { requireRoleToLogin: true });
    expect(p.roles).toEqual(['bruger']);
    expect(p.capabilities).toEqual(['template.use']);
  });

  it('bygger manages its own templates (template.manage), never all of them, access or the log', () => {
    const p = build([{ roleKey: 'bygger', scopeOrgUnitUuid: null }]);
    expect(p.capabilities).toEqual(['template.use', 'template.manage']);
  });

  it('a bygger row from an older version that names a unit grants the same as an unscoped one', () => {
    const p = build([{ roleKey: 'bygger', scopeOrgUnitUuid: OU_A, includeDescendants: false }]);
    expect(p.capabilities).toEqual(['template.use', 'template.manage']);
  });

  it('bruger with a NULL scope adds nothing beyond template.use', () => {
    const p = build([{ roleKey: 'bruger', scopeOrgUnitUuid: null }]);
    expect(p.capabilities).toEqual(['template.use']);
  });

  it('a NULL-scoped admin holds every capability, template.manage_all included', () => {
    const admin = build([{ roleKey: 'admin' }]);
    expect(admin.capabilities).toEqual([...CAPABILITIES]);
    expect(admin.capabilities).toContain('template.manage_all');
  });

  it('a unit-scoped admin gets NO global-only capability (no self-promotion to global admin)', () => {
    const p = build([{ roleKey: 'admin', scopeOrgUnitUuid: OU_A }]);
    expect(p.capabilities).not.toContain('access.manage');
    expect(p.capabilities).not.toContain('sync.run');
    expect(p.capabilities).not.toContain('audit.export');
    expect(p.capabilities).not.toContain('template.manage_all');
    expect(p.capabilities).toEqual(['template.use', 'template.manage']);
  });

  it('a unit-scoped admin can neither read nor export the log', () => {
    const p = build([{ roleKey: 'admin', scopeOrgUnitUuid: OU_A }]);
    expect(p.capabilities).not.toContain('audit.read');
    expect(p.capabilities).not.toContain('audit.export');
  });

  it('a global grant elsewhere still unlocks the global-only capabilities', () => {
    const p = build([{ roleKey: 'admin', scopeOrgUnitUuid: OU_A }, { roleKey: 'admin' }]);
    expect(p.capabilities).toContain('audit.export');
  });

  it('a bygger contributes no global-only capability', () => {
    const p = build([{ roleKey: 'bygger', scopeOrgUnitUuid: null }]);
    for (const cap of GLOBAL_ONLY_CAPABILITIES) expect(p.capabilities).not.toContain(cap);
  });

  it('keeps template.use for a bygger when REQUIRE_ROLE_TO_LOGIN removes the baseline', () => {
    const p = build([{ roleKey: 'bygger' }], { requireRoleToLogin: true });
    expect(p.capabilities).toContain('template.use');
  });

  it('ignores expired and not-yet-started assignments', () => {
    const p = build([
      { roleKey: 'admin', stopDate: new Date('2026-06-01T00:00:00Z') },
      { roleKey: 'admin', startDate: new Date('2026-07-01T00:00:00Z') },
    ]);
    expect(p.roles).toEqual(['bruger']);
    expect(p.capabilities).toEqual(['template.use']);
  });

  it('uses a half-open interval: active at startDate, over at stopDate', () => {
    expect(build([{ roleKey: 'admin', startDate: NOW }]).roles).toContain('admin');
    expect(build([{ roleKey: 'admin', stopDate: NOW }]).roles).not.toContain(
      'admin',
    );
  });

  it('gives a disabled user nothing, even with assignments', () => {
    const p = build([{ roleKey: 'admin' }], { disabled: true });
    expect(p.disabled).toBe(true);
    expect(p.roles).toEqual([]);
    expect(p.capabilities).toEqual([]);
  });

  it('merges duplicate grants without duplicate roles or capabilities', () => {
    const p = build([
      { roleKey: 'bygger', scopeOrgUnitUuid: OU_A, includeDescendants: false },
      { roleKey: 'bygger', scopeOrgUnitUuid: OU_B },
      { roleKey: 'bygger' },
      { roleKey: 'admin' },
    ]);
    expect(p.roles).toEqual(['bruger', 'bygger', 'admin']);
    expect(p.capabilities).toEqual([...CAPABILITIES]);
  });

  it('bygger rows that name units never reach the log, access administration or every template', () => {
    const p = build([
      { roleKey: 'bygger', scopeOrgUnitUuid: OU_A },
      { roleKey: 'bygger', scopeOrgUnitUuid: OU_B, includeDescendants: false },
    ]);
    expect(p.capabilities).toEqual(['template.use', 'template.manage']);
  });

  it('ignores unknown role keys', () => {
    const p = build([{ roleKey: 'tt-superman' }, { roleKey: '' }, { roleKey: 'ADMIN' }]);
    expect(p.roles).toEqual(['bruger']);
    expect(p.capabilities).toEqual(['template.use']);
  });

  it('ignores the removed four-role keys (tt-*) entirely', () => {
    const p = build(
      [
        { roleKey: 'tt-bruger' },
        { roleKey: 'tt-skabelonansvarlig' },
        { roleKey: 'tt-logleser' },
        { roleKey: 'tt-administrator' },
      ],
      { requireRoleToLogin: true },
    );
    expect(p.roles).toEqual([]);
    expect(p.capabilities).toEqual([]);
  });

  it('carries identity through unchanged', () => {
    const p = build([]);
    expect(p.userId).toBe('u1');
    expect(p.directoryUserUuid).toBe('d1');
  });
});

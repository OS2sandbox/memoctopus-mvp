import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rowsRef: { rows: unknown[] } = { rows: [] };
const whereSpy = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: (cond: unknown) => {
            whereSpy(cond);
            return Promise.resolve(rowsRef.rows);
          },
        }),
      }),
    }),
  },
}));

import { resolvePrincipal } from './principal';

const DU = 'dddd0000-0000-4000-8000-000000000001';
const OU = 'aaaa0000-0000-4000-8000-000000000001';

function row(over: Record<string, unknown> = {}) {
  return {
    directoryUserUuid: DU,
    disabled: false,
    roleKey: 'tt-logleser',
    scopeOrgUnitUuid: null,
    includeDescendants: true,
    startDate: null,
    stopDate: null,
    source: 'local',
    ...over,
  };
}

beforeEach(() => {
  rowsRef.rows = [];
  whereSpy.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe('resolvePrincipal', () => {
  it('gives a user with no directory row the tt-bruger baseline', async () => {
    const p = await resolvePrincipal('u1');
    expect(p).toMatchObject({
      userId: 'u1',
      directoryUserUuid: null,
      roles: ['tt-bruger'],
      capabilities: ['template.use'],
      disabled: false,
      source: 'baseline',
    });
  });

  it('gives a user with no directory row NO roles when REQUIRE_ROLE_TO_LOGIN=true', async () => {
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', 'true');
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual([]);
    expect(p.capabilities).toEqual([]);
  });

  it('a linked directory user without assignments is baseline but keeps the directory uuid', async () => {
    rowsRef.rows = [row({ roleKey: null, includeDescendants: null, source: null })];
    const p = await resolvePrincipal('u1');
    expect(p.directoryUserUuid).toBe(DU);
    expect(p.roles).toEqual(['tt-bruger']);
    expect(p.source).toBe('baseline');
  });

  it('resolves an assigned role with global scope', async () => {
    rowsRef.rows = [row()];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['tt-bruger', 'tt-logleser']);
    expect(p.capabilities).toContain('audit.read');
    expect(p.scopes['audit.read']).toEqual({ global: true, roots: [] });
    expect(p.source).toBe('local');
  });

  it('keeps an org-unit scope on a scoped role', async () => {
    rowsRef.rows = [row({ roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: OU, includeDescendants: false })];
    const p = await resolvePrincipal('u1');
    expect(p.scopes['template.manage']).toEqual({
      global: false,
      roots: [{ orgUnitUuid: OU, includeDescendants: false }],
    });
  });

  it('tt-skabelonansvarlig with NULL scope covers nothing (fail closed)', async () => {
    rowsRef.rows = [row({ roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: null })];
    const p = await resolvePrincipal('u1');
    expect(p.scopes['template.manage']).toEqual({ global: false, roots: [] });
  });

  it('a disabled directory user yields a disabled principal without roles', async () => {
    rowsRef.rows = [row({ disabled: true, roleKey: 'tt-administrator' })];
    const p = await resolvePrincipal('u1');
    expect(p.disabled).toBe(true);
    expect(p.roles).toEqual([]);
    expect(p.capabilities).toEqual([]);
  });

  it('ignores expired and not-yet-started assignments', async () => {
    rowsRef.rows = [
      row({ roleKey: 'tt-administrator', stopDate: new Date(Date.now() - 1000) }),
      row({ roleKey: 'tt-logleser', startDate: new Date(Date.now() + 60_000) }),
    ];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['tt-bruger']);
  });

  it('tags the principal rollekatalog when a rollekatalog assignment is active', async () => {
    rowsRef.rows = [row({ source: 'rollekatalog' })];
    expect((await resolvePrincipal('u1')).source).toBe('rollekatalog');
  });

  it('ignores leftover source=local assignments once ACCESS_SOURCE=rollekatalog (they cannot be revoked there)', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    rowsRef.rows = [row({ roleKey: 'tt-administrator', source: 'local' })];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['tt-bruger']);
    expect(p.capabilities).not.toContain('access.manage');
    expect(p.source).toBe('baseline');
  });

  it('still honours rollekatalog assignments in rollekatalog mode, and local ones in local mode', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    rowsRef.rows = [row({ roleKey: 'tt-logleser', source: 'rollekatalog' }), row({ roleKey: 'tt-administrator', source: 'local' })];
    expect((await resolvePrincipal('u1')).roles).toEqual(['tt-bruger', 'tt-logleser']);

    vi.stubEnv('ACCESS_SOURCE', 'local');
    rowsRef.rows = [row({ roleKey: 'tt-administrator', source: 'local' })];
    expect((await resolvePrincipal('u1')).capabilities).toContain('access.manage');
  });

  it('queries live on every call (no cache)', async () => {
    await resolvePrincipal('u1');
    await resolvePrincipal('u1');
    expect(whereSpy).toHaveBeenCalledTimes(2);
  });
});

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

import { loginRefusal } from './guard';
import { dropStaleAssignments, resolvePrincipal, type AssignmentSourceRow } from './principal';

const DU = 'dddd0000-0000-4000-8000-000000000001';
const OU = 'aaaa0000-0000-4000-8000-000000000001';

function row(over: Record<string, unknown> = {}) {
  return {
    directoryUserUuid: DU,
    disabled: false,
    roleKey: 'admin',
    scopeOrgUnitUuid: null,
    includeDescendants: true,
    startDate: null,
    stopDate: null,
    source: 'local',
    syncedAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  rowsRef.rows = [];
  whereSpy.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe('resolvePrincipal', () => {
  it('gives a user with no directory row the bruger baseline', async () => {
    const p = await resolvePrincipal('u1');
    expect(p).toMatchObject({
      userId: 'u1',
      directoryUserUuid: null,
      roles: ['bruger'],
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
    expect(p.roles).toEqual(['bruger']);
    expect(p.source).toBe('baseline');
  });

  it('resolves an assigned role with global scope', async () => {
    rowsRef.rows = [row()];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['bruger', 'admin']);
    expect(p.capabilities).toContain('audit.read');
    expect(p.scopes['audit.read']).toEqual({ global: true, roots: [] });
    expect(p.source).toBe('local');
  });

  it('keeps an org-unit scope on a scoped role', async () => {
    rowsRef.rows = [row({ roleKey: 'bygger', scopeOrgUnitUuid: OU, includeDescendants: false })];
    const p = await resolvePrincipal('u1');
    expect(p.scopes['template.manage']).toEqual({
      global: false,
      roots: [{ orgUnitUuid: OU, includeDescendants: false }],
    });
  });

  it('bygger with NULL scope is global (the superuser)', async () => {
    rowsRef.rows = [row({ roleKey: 'bygger', scopeOrgUnitUuid: null })];
    const p = await resolvePrincipal('u1');
    expect(p.scopes['template.manage']).toEqual({ global: true, roots: [] });
  });

  it('a disabled directory user yields a disabled principal without roles', async () => {
    rowsRef.rows = [row({ disabled: true, roleKey: 'admin' })];
    const p = await resolvePrincipal('u1');
    expect(p.disabled).toBe(true);
    expect(p.roles).toEqual([]);
    expect(p.capabilities).toEqual([]);
  });

  it('ignores expired and not-yet-started assignments', async () => {
    rowsRef.rows = [
      row({ roleKey: 'admin', stopDate: new Date(Date.now() - 1000) }),
      row({ roleKey: 'admin', startDate: new Date(Date.now() + 60_000) }),
    ];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['bruger']);
  });

  it('tags the principal rollekatalog when a rollekatalog assignment is active', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    rowsRef.rows = [row({ source: 'rollekatalog' })];
    expect((await resolvePrincipal('u1')).source).toBe('rollekatalog');
  });

  it('ignores leftover source=local assignments once ACCESS_SOURCE=rollekatalog (they cannot be revoked there)', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    rowsRef.rows = [row({ roleKey: 'admin', source: 'local' })];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['bruger']);
    expect(p.capabilities).not.toContain('access.manage');
    expect(p.source).toBe('baseline');
  });

  it('still honours rollekatalog assignments in rollekatalog mode, and local ones in local mode', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    rowsRef.rows = [row({ roleKey: 'admin', source: 'rollekatalog' }), row({ roleKey: 'admin', source: 'local' })];
    expect((await resolvePrincipal('u1')).roles).toEqual(['bruger', 'admin']);

    vi.stubEnv('ACCESS_SOURCE', 'local');
    rowsRef.rows = [row({ roleKey: 'admin', source: 'local' })];
    expect((await resolvePrincipal('u1')).capabilities).toContain('access.manage');
  });

  it('queries live on every call (no cache)', async () => {
    await resolvePrincipal('u1');
    await resolvePrincipal('u1');
    expect(whereSpy).toHaveBeenCalledTimes(2);
  });
});

const NOW = new Date('2026-01-10T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const r = (source: string, roleKey: string, syncedAt: Date | null | undefined): AssignmentSourceRow => ({
  roleKey,
  scopeOrgUnitUuid: null,
  includeDescendants: true,
  source,
  syncedAt,
});

describe('dropStaleAssignments (pure)', () => {
  const rk = (mode: 'local' | 'rollekatalog', rows: AssignmentSourceRow[], maxAgeSeconds = 100) =>
    dropStaleAssignments(rows, { now: NOW, mode, maxAgeSeconds }).map((x) => x.roleKey);

  it.each([
    ['fresh', ago(10), true],
    ['one second inside the limit', ago(99), true],
    ['exactly at the limit', ago(100), true],
    ['one millisecond past the limit', new Date(NOW.getTime() - 100_001), false],
    ['far older', ago(86_400 * 30), false],
    ['NULL synced_at', null, false],
    ['missing synced_at', undefined, false],
    ['unreadable date', new Date('nope'), false],
    ['in the future (clock skew)', new Date(NOW.getTime() + 5_000), true],
  ])('rollekatalog row, %s -> kept=%s', (_label, syncedAt, kept) => {
    expect(rk('rollekatalog', [r('rollekatalog', 'admin', syncedAt as Date | null | undefined)])).toEqual(
      kept ? ['admin'] : [],
    );
  });

  it('fails closed on an unknown source in either mode', () => {
    expect(rk('rollekatalog', [r('other-source', 'admin', NOW)])).toEqual([]);
    expect(rk('local', [r('other-source', 'admin', NOW)])).toEqual([]);
  });

  it('rollekatalog mode ignores local rows regardless of age', () => {
    expect(rk('rollekatalog', [r('local', 'admin', NOW)])).toEqual([]);
  });

  it('local mode ignores rollekatalog rows (they cannot be edited or revoked there), fresh or not', () => {
    expect(rk('local', [r('rollekatalog', 'admin', NOW), r('rollekatalog', 'admin', null)])).toEqual([]);
  });

  it('local mode keeps local rows, whatever their synced_at', () => {
    expect(rk('local', [r('local', 'admin', null), r('local', 'admin', ago(10_000_000))])).toEqual([
      'admin',
      'admin',
    ]);
  });

  it('mixed rows are filtered row by row', () => {
    expect(
      rk('rollekatalog', [
        r('rollekatalog', 'admin', ago(500)),
        r('rollekatalog', 'admin', ago(5)),
        r('local', 'bygger', ago(5)),
      ]),
    ).toEqual(['admin']);
  });
});

describe('resolvePrincipal staleness and mode symmetry', () => {
  beforeEach(() => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    vi.stubEnv('ROLE_STALE_MAX_SECONDS', '3600');
  });

  const old = () => new Date(Date.now() - 7_200_000);

  it('a stale rollekatalog elevated role is dropped; the baseline bruger stays', async () => {
    rowsRef.rows = [row({ roleKey: 'admin', source: 'rollekatalog', syncedAt: old() })];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['bruger']);
    expect(p.capabilities).toEqual(['template.use']);
    expect(p.source).toBe('baseline');
    expect(p.disabled).toBe(false);
  });

  it('keeps the directory link and a REQUIRE_ROLE_TO_LOGIN principal empty when every row is stale', async () => {
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', 'true');
    rowsRef.rows = [row({ roleKey: 'admin', source: 'rollekatalog', syncedAt: null })];
    const p = await resolvePrincipal('u1');
    expect(p.directoryUserUuid).toBe(DU);
    expect(p.roles).toEqual([]);
  });

  it('a fresh row survives next to a stale one, and source stays truthful', async () => {
    rowsRef.rows = [
      row({ roleKey: 'admin', source: 'rollekatalog', syncedAt: old() }),
      row({ roleKey: 'bygger', source: 'rollekatalog', syncedAt: new Date() }),
    ];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['bruger', 'bygger']);
    expect(p.capabilities).not.toContain('access.manage');
    expect(p.source).toBe('rollekatalog');
  });

  it('uses ROLE_STALE_MAX_SECONDS at call time', async () => {
    rowsRef.rows = [row({ roleKey: 'admin', source: 'rollekatalog', syncedAt: new Date(Date.now() - 120_000) })];
    vi.stubEnv('ROLE_STALE_MAX_SECONDS', '60');
    expect((await resolvePrincipal('u1')).roles).toEqual(['bruger']);
    vi.stubEnv('ROLE_STALE_MAX_SECONDS', '600');
    expect((await resolvePrincipal('u1')).roles).toEqual(['bruger', 'admin']);
  });

  it('an invalid ROLE_STALE_MAX_SECONDS falls back to 24 hours', async () => {
    vi.stubEnv('ROLE_STALE_MAX_SECONDS', 'soon');
    rowsRef.rows = [
      row({ roleKey: 'admin', source: 'rollekatalog', syncedAt: new Date(Date.now() - 23 * 3_600_000) }),
      row({ roleKey: 'admin', source: 'rollekatalog', syncedAt: new Date(Date.now() - 25 * 3_600_000) }),
    ];
    expect((await resolvePrincipal('u1')).roles).toEqual(['bruger', 'admin']);
  });

  it('in local mode a rollekatalog row is ignored even when fresh, and local rows still work', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    rowsRef.rows = [
      row({ roleKey: 'admin', source: 'rollekatalog', syncedAt: new Date() }),
      row({ roleKey: 'bygger', source: 'local' }),
    ];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['bruger', 'bygger']);
    expect(p.capabilities).not.toContain('access.manage');
    expect(p.source).toBe('local');
  });

  it('in rollekatalog mode a local row is ignored next to a fresh rollekatalog row', async () => {
    rowsRef.rows = [
      row({ roleKey: 'admin', source: 'local' }),
      row({ roleKey: 'admin', source: 'rollekatalog', syncedAt: new Date() }),
    ];
    expect((await resolvePrincipal('u1')).roles).toEqual(['bruger', 'admin']);
  });
});

describe('resolvePrincipal with an invalid ACCESS_SOURCE', () => {
  it.each(['rolekatalog', 'ldap'])('throws ConfigError for "%s" instead of resolving under local mode', async (v) => {
    vi.stubEnv('ACCESS_SOURCE', v);
    rowsRef.rows = [row({ roleKey: 'admin' })];
    await expect(resolvePrincipal('u1')).rejects.toMatchObject({ name: 'ConfigError' });
  });
});

describe('dropStaleAssignments, claims mode (pure)', () => {
  const cl = (rows: AssignmentSourceRow[], claimsMaxAgeSeconds = 100, maxAgeSeconds = 5) =>
    dropStaleAssignments(rows, { now: NOW, mode: 'claims', maxAgeSeconds, claimsMaxAgeSeconds }).map((x) => x.roleKey);

  it.each([
    ['fresh', ago(10), true],
    ['exactly at the limit', ago(100), true],
    ['one millisecond past it', new Date(NOW.getTime() - 100_001), false],
    ['NULL synced_at', null, false],
    ['unreadable date', new Date('nope'), false],
  ])('claims row, %s -> kept=%s (against ROLE_CLAIMS_MAX_SECONDS, not the Rollekatalog limit)', (_l, syncedAt, kept) => {
    expect(cl([r('claims', 'admin', syncedAt as Date | null)])).toEqual(kept ? ['admin'] : []);
  });

  it('local and rollekatalog rows grant nothing in claims mode, however fresh; unknown sources neither', () => {
    expect(cl([r('local', 'admin', NOW), r('rollekatalog', 'admin', NOW), r('other', 'admin', NOW)])).toEqual([]);
  });

  it('claims rows grant nothing in the other modes', () => {
    const rows = [r('claims', 'admin', NOW)];
    expect(dropStaleAssignments(rows, { now: NOW, mode: 'local', maxAgeSeconds: 100 })).toEqual([]);
    expect(dropStaleAssignments(rows, { now: NOW, mode: 'rollekatalog', maxAgeSeconds: 100 })).toEqual([]);
  });
});

describe('resolvePrincipal in claims mode', () => {
  beforeEach(() => {
    vi.stubEnv('ACCESS_SOURCE', 'claims');
    vi.stubEnv('ROLE_CLAIMS_MAX_SECONDS', '3600');
    // These cases are about WHICH rows count; the baseline role they fall back to only exists when
    // the installation opted out of "no role, no access" (see the next describe for the default).
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', 'false');
  });

  it('a fresh claims role resolves, tagged claims; global NULL scope on a role that may be global', async () => {
    rowsRef.rows = [row({ roleKey: 'bygger', source: 'claims', syncedAt: new Date() })];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['bruger', 'bygger']);
    expect(p.scopes['template.manage']).toEqual({ global: true, roots: [] });
    expect(p.source).toBe('claims');
  });

  it('access.manage still needs a GLOBAL administrator: a claims admin row is NULL-scoped, so it has it', async () => {
    rowsRef.rows = [row({ roleKey: 'admin', source: 'claims', syncedAt: new Date() })];
    expect((await resolvePrincipal('u1')).capabilities).toEqual(expect.arrayContaining(['access.manage', 'sync.run', 'audit.export']));
  });

  it('a snapshot older than ROLE_CLAIMS_MAX_SECONDS grants nothing: the baseline bruger only', async () => {
    rowsRef.rows = [row({ roleKey: 'admin', source: 'claims', syncedAt: new Date(Date.now() - 2 * 3_600_000) })];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['bruger']);
    expect(p.capabilities).toEqual(['template.use']);
    expect(p.source).toBe('baseline');
    expect(p.directoryUserUuid).toBe(DU);
  });

  it('with REQUIRE_ROLE_TO_LOGIN a stale snapshot leaves the person without any role (refused at login)', async () => {
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', 'true');
    rowsRef.rows = [row({ roleKey: 'admin', source: 'claims', syncedAt: new Date(Date.now() - 2 * 3_600_000) })];
    expect((await resolvePrincipal('u1')).roles).toEqual([]);
  });

  it('reads ROLE_CLAIMS_MAX_SECONDS at call time; an unusable value means the 8 hour default, never "unlimited"', async () => {
    rowsRef.rows = [row({ roleKey: 'admin', source: 'claims', syncedAt: new Date(Date.now() - 600_000) })];
    vi.stubEnv('ROLE_CLAIMS_MAX_SECONDS', '300');
    expect((await resolvePrincipal('u1')).roles).toEqual(['bruger']);
    vi.stubEnv('ROLE_CLAIMS_MAX_SECONDS', '3600');
    expect((await resolvePrincipal('u1')).roles).toEqual(['bruger', 'admin']);
    vi.stubEnv('ROLE_CLAIMS_MAX_SECONDS', 'forever');
    rowsRef.rows = [row({ roleKey: 'admin', source: 'claims', syncedAt: new Date(Date.now() - 9 * 3_600_000) })];
    expect((await resolvePrincipal('u1')).roles).toEqual(['bruger']);
  });

  it('local and rollekatalog rows are ignored next to a fresh claims row', async () => {
    rowsRef.rows = [
      row({ roleKey: 'admin', source: 'local' }),
      row({ roleKey: 'admin', source: 'rollekatalog', syncedAt: new Date() }),
      row({ roleKey: 'bygger', source: 'claims', syncedAt: new Date() }),
    ];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['bruger', 'bygger']);
    expect(p.capabilities).not.toContain('access.manage');
  });

  it('a claims row is ignored once the installation is back in local mode', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'local');
    rowsRef.rows = [row({ roleKey: 'admin', source: 'claims', syncedAt: new Date() })];
    expect((await resolvePrincipal('u1')).roles).toEqual(['bruger']);
  });

  it('a disabled directory row refuses the person whatever the claims say', async () => {
    rowsRef.rows = [row({ disabled: true, roleKey: 'admin', source: 'claims', syncedAt: new Date() })];
    const p = await resolvePrincipal('u1');
    expect(p.disabled).toBe(true);
    expect(p.roles).toEqual([]);
  });
});

describe('claims mode requires a mapped role by default', () => {
  beforeEach(() => {
    vi.stubEnv('ACCESS_SOURCE', 'claims');
    vi.stubEnv('ROLE_CLAIMS_MAX_SECONDS', '3600');
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', '');
  });

  it('a person the IdP mapped to no role (no row at all) has no role, not even the baseline', async () => {
    const p = await resolvePrincipal('u1');
    expect(p).toMatchObject({ roles: [], capabilities: [], directoryUserUuid: null });
    expect(loginRefusal(p)).toBe('no_role');
  });

  it('a stale or foreign-source row leaves nobody with a role either', async () => {
    rowsRef.rows = [
      row({ roleKey: 'admin', source: 'claims', syncedAt: new Date(Date.now() - 2 * 3_600_000) }),
      row({ roleKey: 'admin', source: 'local' }),
    ];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual([]);
    expect(loginRefusal(p)).toBe('no_role');
  });

  it('a mapped role (even just bruger) logs in', async () => {
    rowsRef.rows = [row({ roleKey: 'bruger', source: 'claims', syncedAt: new Date() })];
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['bruger']);
    expect(loginRefusal(p)).toBeNull();
  });

  it('only an explicit REQUIRE_ROLE_TO_LOGIN=false brings the baseline back', async () => {
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', 'false');
    const p = await resolvePrincipal('u1');
    expect(p.roles).toEqual(['bruger']);
    expect(loginRefusal(p)).toBeNull();
  });

  it('the other modes keep the baseline by default', async () => {
    for (const mode of ['local', 'rollekatalog']) {
      vi.stubEnv('ACCESS_SOURCE', mode);
      expect((await resolvePrincipal('u1')).roles).toEqual(['bruger']);
    }
  });
});

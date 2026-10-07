import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner, type Responder } from '@/test/fake-runner';

vi.mock('@/lib/db', () => ({ pool: {} }));
// Rights and organisation changes are NOT audited (only denials are): the mock is a tripwire.
const recordEvent = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@/lib/audit/record', () => ({
  recordEvent: (...a: unknown[]) => recordEvent(...a),
}));

import {
  ConflictError,
  NotFoundError,
  ReadOnlyModeError,
  ValidationError,
} from './access-errors';
import {
  createOrgUnit,
  deleteOrgUnit,
  grantRole,
  listAppUsersWithRoles,
  listOrgUnits,
  revokeAssignment,
  setOrgUnitMembers,
  updateOrgUnit,
  validateGrantShape,
} from './access-admin';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const DIR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ASG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
  vi.stubEnv('ACCESS_SOURCE', 'local');
  recordEvent.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

/** First responder whose needle occurs in the SQL wins; unmatched statements return no rows. */
function respondBy(rules: Array<[needle: string, rows: Array<Record<string, unknown>> | (() => Array<Record<string, unknown>>)]>): Responder {
  return (sql) => {
    for (const [needle, rows] of rules) {
      if (sql.includes(needle)) return typeof rows === 'function' ? rows() : rows;
    }
    return [];
  };
}

describe('validateGrantShape', () => {
  const base = { scopeOrgUnitUuid: null, startDate: null, stopDate: null };

  it('rejects an unknown role key', () => {
    expect(() => validateGrantShape({ ...base, roleKey: 'tt-god' })).toThrow(ValidationError);
  });

  it('forbids a scope on tt-bruger', () => {
    expect(() => validateGrantShape({ ...base, roleKey: 'tt-bruger', scopeOrgUnitUuid: U1 })).toThrow(/begrænses/);
    expect(validateGrantShape({ ...base, roleKey: 'tt-bruger' })).toBe('tt-bruger');
  });

  it('requires a scope on tt-skabelonansvarlig (a NULL scope would cover nothing)', () => {
    expect(() => validateGrantShape({ ...base, roleKey: 'tt-skabelonansvarlig' })).toThrow(/kræver/);
    expect(validateGrantShape({ ...base, roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: U1 })).toBe(
      'tt-skabelonansvarlig',
    );
  });

  it('allows tt-logleser with and without scope', () => {
    expect(validateGrantShape({ ...base, roleKey: 'tt-logleser' })).toBe('tt-logleser');
    expect(validateGrantShape({ ...base, roleKey: 'tt-logleser', scopeOrgUnitUuid: U1 })).toBe('tt-logleser');
  });

  it('forbids a scope on tt-administrator: its access.manage/sync.run cannot be narrowed to a unit', () => {
    expect(validateGrantShape({ ...base, roleKey: 'tt-administrator' })).toBe('tt-administrator');
    expect(() => validateGrantShape({ ...base, roleKey: 'tt-administrator', scopeOrgUnitUuid: U1 })).toThrow(
      expect.objectContaining({ code: 'scope_forbidden' }),
    );
  });

  it('rejects a malformed scope uuid', () => {
    expect(() => validateGrantShape({ ...base, roleKey: 'tt-logleser', scopeOrgUnitUuid: 'nope' })).toThrow(
      ValidationError,
    );
  });

  it('rejects stop <= start and invalid dates', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(() => validateGrantShape({ ...base, roleKey: 'tt-bruger', startDate: d, stopDate: d })).toThrow(/Slutdato/);
    expect(() =>
      validateGrantShape({ ...base, roleKey: 'tt-bruger', startDate: new Date(NaN) }),
    ).toThrow(/dato/);
    expect(() =>
      validateGrantShape({ ...base, roleKey: 'tt-bruger', startDate: d, stopDate: new Date('2026-02-01T00:00:00Z') }),
    ).not.toThrow();
  });
});

describe('read-only mode', () => {
  it.each([
    ['grantRole', (r: never) => grantRole({ appUserId: 'u', roleKey: 'tt-bruger', actorUserId: 'a' }, r)],
    ['revokeAssignment', (r: never) => revokeAssignment(ASG, 'a', r)],
    ['createOrgUnit', (r: never) => createOrgUnit({ name: 'x', actorUserId: 'a' }, r)],
    ['updateOrgUnit', (r: never) => updateOrgUnit(U1, { name: 'x' }, 'a', r)],
    ['deleteOrgUnit', (r: never) => deleteOrgUnit(U1, 'a', r)],
    ['setOrgUnitMembers', (r: never) => setOrgUnitMembers(U1, [], 'a', r)],
  ])('%s refuses without touching the database in rollekatalog mode', async (_n, call) => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    const { runner, calls } = makeFakeRunner();
    await expect(call(runner as never)).rejects.toBeInstanceOf(ReadOnlyModeError);
    expect(calls).toHaveLength(0);
    expect(recordEvent).not.toHaveBeenCalled();
  });
});

describe('grantRole', () => {
  const input = { appUserId: 'app-1', roleKey: 'tt-logleser', actorUserId: 'admin-1' };
  const assignmentRow = {
    assignment_id: ASG,
    role_key: 'tt-logleser',
    scope_org_unit_uuid: null,
    scope_name: null,
    include_descendants: true,
    start_date: null,
    stop_date: null,
    assignment_source: 'local',
    active: true,
  };

  const happy = () =>
    respondBy([
      ['FROM public.users WHERE id = $1', [{ '?column?': 1 }]],
      ['INSERT INTO public.directory_users', [{ uuid: DIR }]],
      ['SELECT uuid, app_user_id, disabled', [{ uuid: DIR, app_user_id: 'app-1', disabled: false }]],
      ['INSERT INTO public.role_assignments', [{ id: ASG }]],
      ['FROM public.role_assignments ra', [assignmentRow]],
    ]);

  it('links by app_user_id (never email), inserts a local row inside the transaction, without an audit event', async () => {
    const { runner, calls } = makeFakeRunner(happy());
    const view = await grantRole({ ...input, scopeOrgUnitUuid: null }, runner);

    expect(view).toMatchObject({ id: ASG, roleKey: 'tt-logleser', source: 'local', scopeOrgUnitUuid: null });
    const sqls = calls.map((c) => c.sql).join('\n');
    expect(sqls).not.toMatch(/lower\(email\)|email =/i);
    expect(calls.every((c) => c.tx)).toBe(true);

    const insert = calls.find((c) => c.sql.includes('INSERT INTO public.role_assignments'))!;
    expect(insert.sql).toContain("'local'");
    expect(insert.params).toEqual([DIR, 'tt-logleser', null, true, null, null, 'admin-1']);

    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('locks the scope unit FOR SHARE and lowercases it', async () => {
    const { runner, calls } = makeFakeRunner((sql, p) =>
      sql.includes('FROM public.org_units WHERE uuid = $1::uuid FOR SHARE') ? [{ '?column?': 1 }] : happy()(sql, p, true),
    );
    await grantRole({ ...input, roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: U1.toUpperCase() }, runner);
    const lock = calls.find((c) => c.sql.includes('FOR SHARE'))!;
    expect(lock.params).toEqual([U1]);
  });

  it('stores include_descendants true for a global grant even if false was sent', async () => {
    const { runner, calls } = makeFakeRunner(happy());
    await grantRole({ ...input, includeDescendants: false }, runner);
    expect(calls.find((c) => c.sql.includes('INSERT INTO public.role_assignments'))!.params[3]).toBe(true);
  });

  it('404 for an unknown user, before any write', async () => {
    const { runner, calls } = makeFakeRunner(respondBy([]));
    await expect(grantRole(input, runner)).rejects.toMatchObject({ code: 'user_not_found' });
    expect(calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });

  it('404 for an unknown scope unit', async () => {
    const { runner } = makeFakeRunner(respondBy([['FROM public.users WHERE id = $1', [{ x: 1 }]]]));
    await expect(grantRole({ ...input, roleKey: 'tt-skabelonansvarlig', scopeOrgUnitUuid: U1 }, runner)).rejects.toMatchObject({
      code: 'org_unit_not_found',
    });
  });

  it('409 when the same role is already assigned (insert returns no row)', async () => {
    const { runner } = makeFakeRunner(
      respondBy([
        ['FROM public.users WHERE id = $1', [{ x: 1 }]],
        ['SELECT uuid, app_user_id, disabled', [{ uuid: DIR, app_user_id: 'app-1', disabled: false }]],
      ]),
    );
    await expect(grantRole(input, runner)).rejects.toMatchObject({ code: 'already_assigned' });
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('409 for a disabled directory user', async () => {
    const { runner } = makeFakeRunner(
      respondBy([
        ['FROM public.users WHERE id = $1', [{ x: 1 }]],
        ['SELECT uuid, app_user_id, disabled', [{ uuid: DIR, app_user_id: 'app-1', disabled: true }]],
      ]),
    );
    await expect(grantRole(input, runner)).rejects.toMatchObject({ code: 'user_disabled' });
  });

  it('validates the role shape before opening a transaction', async () => {
    const { runner, calls } = makeFakeRunner();
    await expect(grantRole({ ...input, roleKey: 'tt-skabelonansvarlig' }, runner)).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it('turns a late unique/FK violation into a 409-style ConflictError', async () => {
    const { runner } = makeFakeRunner(() => {
      throw Object.assign(new Error('boom'), { code: '23503' });
    });
    await expect(grantRole(input, runner)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('revokeAssignment', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: ASG,
    role_key: 'tt-administrator',
    source: 'local',
    directory_user_uuid: DIR,
    scope_org_unit_uuid: null,
    app_user_id: 'admin-1',
    active: true,
    ...over,
  });

  const responder = (found: Record<string, unknown> | null, otherAdmins: number) =>
    respondBy([
      ['FOR UPDATE OF ra', found ? [found] : []],
      ['count(*)::int AS n', [{ n: otherAdmins }]],
    ]);

  it('refuses the LAST active administrator and deletes nothing', async () => {
    const { runner, calls } = makeFakeRunner(responder(row({ app_user_id: 'someone-else' }), 0));
    await expect(revokeAssignment(ASG, 'admin-2', runner)).rejects.toMatchObject({ code: 'last_administrator' });
    expect(calls.some((c) => c.sql.startsWith('DELETE'))).toBe(false);
    expect(calls.at(-1)!.sql).toBe('ROLLBACK');
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('gives a specific message when the actor revokes their own last admin role', async () => {
    const { runner } = makeFakeRunner(responder(row(), 0));
    await expect(revokeAssignment(ASG, 'admin-1', runner)).rejects.toThrow(/din egen administratorrolle/);
  });

  it('allows the revoke when another active local administrator remains', async () => {
    const { runner, calls } = makeFakeRunner(responder(row(), 1));
    await revokeAssignment(ASG, 'admin-1', runner);
    expect(calls.some((c) => c.sql.startsWith('DELETE FROM public.role_assignments'))).toBe(true);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('takes the advisory lock before reading the assignment and counting admins', async () => {
    const { runner, sqls } = makeFakeRunner(responder(row(), 1));
    await revokeAssignment(ASG, 'admin-1', runner);
    const order = sqls();
    const lock = order.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(order.findIndex((s) => s.includes('FOR UPDATE OF ra')));
    expect(lock).toBeLessThan(order.findIndex((s) => s.includes('count(*)')));
  });

  it('counts only local, started, permanent (no stop_date), enabled, login-capable administrators', async () => {
    const { runner, calls } = makeFakeRunner(responder(row(), 1));
    await revokeAssignment(ASG, 'admin-1', runner);
    const count = calls.find((c) => c.sql.includes('count(*)::int'))!.sql;
    expect(count).toContain("ra.source = 'local'");
    expect(count).toContain('du.disabled = false');
    expect(count).toContain('du.app_user_id IS NOT NULL');
    expect(count).toContain('ra.stop_date IS NULL');
    expect(count).not.toContain('stop_date > now()');
    expect(count).toContain('ra.start_date <= now()');
    expect(count).toContain('ra.id <> $1');
  });

  it('does not count when the admin assignment being removed is already expired', async () => {
    const { runner, sqls } = makeFakeRunner(responder(row({ active: false }), 0));
    await revokeAssignment(ASG, 'admin-1', runner);
    expect(sqls().some((s) => s.includes('count(*)'))).toBe(false);
  });

  it('does not apply the admin guard to a scoped (non-global) admin row: it grants no access.manage', async () => {
    const { runner, sqls } = makeFakeRunner(responder(row({ scope_org_unit_uuid: U1 }), 0));
    await revokeAssignment(ASG, 'admin-1', runner);
    expect(sqls().some((s) => s.includes('count(*)'))).toBe(false);
  });

  it('counts only GLOBAL administrators as "another admin"', async () => {
    const { runner, calls } = makeFakeRunner(responder(row(), 1));
    await revokeAssignment(ASG, 'admin-1', runner);
    expect(calls.find((c) => c.sql.includes('count(*)::int'))!.sql).toContain('ra.scope_org_unit_uuid IS NULL');
  });

  it('does not apply the admin guard to other roles', async () => {
    const { runner, sqls } = makeFakeRunner(responder(row({ role_key: 'tt-logleser' }), 0));
    await revokeAssignment(ASG, 'admin-1', runner);
    expect(sqls().some((s) => s.includes('count(*)'))).toBe(false);
  });

  it('only source=local rows are editable', async () => {
    const { runner, calls } = makeFakeRunner(responder(row({ source: 'rollekatalog' }), 5));
    await expect(revokeAssignment(ASG, 'admin-1', runner)).rejects.toMatchObject({ code: 'not_local' });
    expect(calls.some((c) => c.sql.startsWith('DELETE'))).toBe(false);
  });

  it('404 for a missing assignment and for a malformed id (no query for the latter)', async () => {
    await expect(revokeAssignment(ASG, 'a', makeFakeRunner(responder(null, 0)).runner)).rejects.toBeInstanceOf(NotFoundError);
    const { runner, calls } = makeFakeRunner();
    await expect(revokeAssignment('not-a-uuid', 'a', runner)).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toHaveLength(0);
  });
});

describe('org units', () => {
  const unit = (uuid: string, over: Record<string, unknown> = {}) => ({
    uuid,
    name: 'Enhed',
    parent_uuid: null,
    source: 'local',
    ...over,
  });

  describe('createOrgUnit', () => {
    it('rejects an empty or overlong name before any query', async () => {
      const { runner, calls } = makeFakeRunner();
      await expect(createOrgUnit({ name: '   ', actorUserId: 'a' }, runner)).rejects.toBeInstanceOf(ValidationError);
      await expect(createOrgUnit({ name: 'x'.repeat(201), actorUserId: 'a' }, runner)).rejects.toBeInstanceOf(ValidationError);
      expect(calls).toHaveLength(0);
    });

    it('404 when the parent does not exist', async () => {
      const { runner } = makeFakeRunner(respondBy([]));
      await expect(createOrgUnit({ name: 'A', parentUuid: U1, actorUserId: 'a' }, runner)).rejects.toMatchObject({
        code: 'parent_not_found',
      });
    });

    it('creates a local unit and trims the name', async () => {
      const { runner, calls } = makeFakeRunner(
        respondBy([
          ['FOR SHARE', [{ x: 1 }]],
          ['INSERT INTO public.org_units', [unit(U2, { name: 'A', parent_uuid: U1 })]],
        ]),
      );
      const view = await createOrgUnit({ name: '  A ', parentUuid: U1, actorUserId: 'a' }, runner);
      expect(view).toEqual({ uuid: U2, name: 'A', parentUuid: U1, source: 'local', memberCount: 0 });
      expect(calls.find((c) => c.sql.includes('INSERT INTO public.org_units'))!.params).toEqual(['A', U1]);
      expect(recordEvent).not.toHaveBeenCalled();
    });
  });

  describe('updateOrgUnit cycle prevention', () => {
    // Tree: U1 > U2 > U3. `cyclic` is what the ancestor walk from the new parent finds: a row when this unit is on it.
    const run = (patch: { name?: string; parentUuid?: string | null }, id: string, cur: Record<string, unknown>, cyclic: boolean) => {
      const fake = makeFakeRunner(
        respondBy([
          ['WITH RECURSIVE ancestors', cyclic ? [{ x: 1 }] : []],
          ['FROM public.org_units WHERE uuid = $1::uuid FOR SHARE', [{ x: 1 }]],
          ['FOR UPDATE', [cur]],
          ['UPDATE public.org_units', [{ ...cur, ...(patch.name ? { name: patch.name } : {}), parent_uuid: 'parentUuid' in patch ? patch.parentUuid : cur.parent_uuid }]],
        ]),
      );
      return { ...fake, result: updateOrgUnit(id, patch, 'a', fake.runner) };
    };

    it('refuses making a unit its own parent (400) without any query', async () => {
      const { runner, calls } = makeFakeRunner();
      await expect(updateOrgUnit(U1, { parentUuid: U1 }, 'a', runner)).rejects.toMatchObject({ code: 'self_parent' });
      expect(calls).toHaveLength(0);
    });

    it('refuses moving a unit under one of its descendants (409) and writes nothing', async () => {
      const { result, calls } = run({ parentUuid: U3 }, U1, unit(U1), true);
      await expect(result).rejects.toMatchObject({ code: 'cycle' });
      expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
      expect(recordEvent).not.toHaveBeenCalled();
    });

    it('walks up from the new parent without a depth cap, so a deep chain cannot hide a cycle', async () => {
      const { result, calls } = run({ parentUuid: U3 }, U1, unit(U1), true);
      await expect(result).rejects.toMatchObject({ code: 'cycle' });
      const walk = calls.find((c) => c.sql.includes('WITH RECURSIVE ancestors'))!;
      expect(walk.params).toEqual([U3, U1]);
      expect(walk.sql).toContain('UNION\n');
      expect(walk.sql).not.toMatch(/depth/i);
    });

    it('refuses moving under a direct child too', async () => {
      const { result } = run({ parentUuid: U2 }, U1, unit(U1), true);
      await expect(result).rejects.toBeInstanceOf(ConflictError);
    });

    it('allows moving under a unit outside the subtree', async () => {
      const OUTSIDE = '44444444-4444-4444-8444-444444444444';
      const { result, calls } = run({ parentUuid: OUTSIDE }, U3, unit(U3, { parent_uuid: U2 }), false);
      await expect(result).resolves.toMatchObject({ uuid: U3, parentUuid: OUTSIDE });
      expect(calls.find((c) => c.sql.startsWith('UPDATE'))!.sql).toContain('parent_uuid = $2::uuid');
      expect(recordEvent).not.toHaveBeenCalled();
    });

    it('serialises tree moves on an advisory lock taken before reading the unit', async () => {
      const { result, sqls } = run({ parentUuid: null }, U3, unit(U3, { parent_uuid: U2 }), false);
      await result;
      const order = sqls();
      expect(order.findIndex((s) => s.includes('pg_advisory_xact_lock'))).toBeLessThan(
        order.findIndex((s) => s.includes('FOR UPDATE')),
      );
    });

    it('makes a unit a root with parentUuid null without a cycle check', async () => {
      const { result, sqls } = run({ parentUuid: null }, U3, unit(U3, { parent_uuid: U2 }), false);
      await expect(result).resolves.toMatchObject({ parentUuid: null });
      expect(sqls().some((s) => s.includes('WITH RECURSIVE'))).toBe(false);
    });

    it('a rename needs no tree lock', async () => {
      const { result, sqls } = run({ name: 'Nyt' }, U1, unit(U1), false);
      await expect(result).resolves.toMatchObject({ name: 'Nyt' });
      expect(sqls().some((s) => s.includes('pg_advisory_xact_lock'))).toBe(false);
    });

    it('is a no-op (no UPDATE, no audit) when nothing changes', async () => {
      const { result, calls } = run({ name: 'Enhed' }, U1, unit(U1), false);
      await result;
      expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
      expect(recordEvent).not.toHaveBeenCalled();
    });

    it('404 for a missing unit, 409 for a rollekatalog unit, 400 for an empty patch', async () => {
      const missing = makeFakeRunner(respondBy([]));
      await expect(updateOrgUnit(U1, { name: 'x' }, 'a', missing.runner)).rejects.toBeInstanceOf(NotFoundError);

      const synced = makeFakeRunner(respondBy([['FOR UPDATE', [unit(U1, { source: 'rollekatalog' })]]]));
      await expect(updateOrgUnit(U1, { name: 'x' }, 'a', synced.runner)).rejects.toMatchObject({ code: 'not_local' });

      await expect(updateOrgUnit(U1, {}, 'a', makeFakeRunner().runner)).rejects.toMatchObject({ code: 'empty_patch' });
    });

    it('404 when the new parent does not exist', async () => {
      const fake = makeFakeRunner(respondBy([['FOR UPDATE', [unit(U3)]]]));
      // FOR SHARE matches the FOR UPDATE needle only for the unit read; the parent lookup returns nothing.
      await expect(updateOrgUnit(U3, { parentUuid: U1 }, 'a', fake.runner)).rejects.toMatchObject({
        code: 'parent_not_found',
      });
    });
  });

  describe('deleteOrgUnit', () => {
    const run = (over: { source?: string; children?: boolean; assigned?: boolean; exists?: boolean; owns?: boolean }) =>
      makeFakeRunner(
        respondBy([
          ['SELECT source FROM public.org_units', over.exists === false ? [] : [{ source: over.source ?? 'local' }]],
          ['WHERE parent_uuid', over.children ? [{ x: 1 }] : []],
          ['WHERE scope_org_unit_uuid', over.assigned ? [{ x: 1 }] : []],
          ['FROM public.central_templates', over.owns ? [{ x: 1 }] : []],
        ]),
      );

    it('409 with a Danish message while it owns central templates (the RESTRICT FK), without deleting', async () => {
      const { runner, calls } = run({ owns: true });
      await expect(deleteOrgUnit(U1, 'a', runner)).rejects.toMatchObject({
        code: 'has_central_templates',
        message: expect.stringContaining('centrale skabeloner'),
      });
      expect(calls.some((c) => c.sql.startsWith('DELETE'))).toBe(false);
      expect(recordEvent).not.toHaveBeenCalled();
    });

    it('deletes a leaf without assignments', async () => {
      const { runner, calls } = run({});
      await deleteOrgUnit(U1, 'a', runner);
      expect(calls.some((c) => c.sql.startsWith('DELETE FROM public.org_units'))).toBe(true);
      expect(recordEvent).not.toHaveBeenCalled();
    });

    it('409 when it has children', async () => {
      const { runner, calls } = run({ children: true });
      await expect(deleteOrgUnit(U1, 'a', runner)).rejects.toMatchObject({ code: 'has_children' });
      expect(calls.some((c) => c.sql.startsWith('DELETE'))).toBe(false);
    });

    it('409 when role assignments are scoped to it (the FK would cascade-delete them)', async () => {
      const { runner, calls } = run({ assigned: true });
      await expect(deleteOrgUnit(U1, 'a', runner)).rejects.toMatchObject({ code: 'has_role_assignments' });
      expect(calls.some((c) => c.sql.startsWith('DELETE'))).toBe(false);
    });

    it('404 for a missing unit, 409 for a rollekatalog unit', async () => {
      await expect(deleteOrgUnit(U1, 'a', run({ exists: false }).runner)).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteOrgUnit(U1, 'a', run({ source: 'rollekatalog' }).runner)).rejects.toMatchObject({ code: 'not_local' });
    });
  });

  describe('setOrgUnitMembers', () => {
    const D1 = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
    const D2 = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
    const D3 = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';

    const run = (wanted: string[], existing: string[], known = wanted) =>
      makeFakeRunner(
        respondBy([
          ['SELECT source FROM public.org_units', [{ source: 'local' }]],
          ['SELECT id FROM public.users', known.map((id) => ({ id }))],
          ['INSERT INTO public.directory_users', []],
          [
            'SELECT uuid, app_user_id, disabled',
            wanted.map((id, i) => ({ uuid: [D1, D2, D3][i], app_user_id: id, disabled: false })),
          ],
          ['SELECT directory_user_uuid FROM public.org_unit_members', existing.map((d) => ({ directory_user_uuid: d }))],
          ['JOIN public.directory_users du', []],
        ]),
      );

    it('diffs: removes missing members and adds new ones', async () => {
      const { runner, calls } = run(['a1', 'a2'], [D2, D3]);
      await setOrgUnitMembers(U1, ['a1', 'a2', 'a1'], 'admin', runner);

      const del = calls.find((c) => c.sql.startsWith('DELETE FROM public.org_unit_members'))!;
      expect(del.params).toEqual([U1, [D3]]);
      const ins = calls.find((c) => c.sql.startsWith('INSERT INTO public.org_unit_members'))!;
      expect(ins.params).toEqual([U1, [D1]]);
      expect(recordEvent).not.toHaveBeenCalled();
    });

    it('an empty list clears the unit', async () => {
      const { runner, calls } = run([], [D1]);
      await setOrgUnitMembers(U1, [], 'admin', runner);
      expect(calls.find((c) => c.sql.startsWith('DELETE FROM public.org_unit_members'))!.params).toEqual([U1, [D1]]);
      expect(calls.some((c) => c.sql.startsWith('INSERT INTO public.org_unit_members'))).toBe(false);
    });

    it('404 when any app user is unknown, before writing anything', async () => {
      const { runner, calls } = run(['a1', 'ghost'], [], ['a1']);
      await expect(setOrgUnitMembers(U1, ['a1', 'ghost'], 'admin', runner)).rejects.toMatchObject({ code: 'user_not_found' });
      expect(calls.some((c) => c.sql.startsWith('INSERT') || c.sql.startsWith('DELETE'))).toBe(false);
    });

    it('409 for a rollekatalog unit; 404 for a missing one; 400 for too many members', async () => {
      const synced = makeFakeRunner(respondBy([['SELECT source FROM public.org_units', [{ source: 'rollekatalog' }]]]));
      await expect(setOrgUnitMembers(U1, [], 'a', synced.runner)).rejects.toMatchObject({ code: 'not_local' });
      await expect(setOrgUnitMembers(U1, [], 'a', makeFakeRunner().runner)).rejects.toBeInstanceOf(NotFoundError);
      const many = Array.from({ length: 1001 }, (_, i) => `u${i}`);
      await expect(setOrgUnitMembers(U1, many, 'a', makeFakeRunner().runner)).rejects.toMatchObject({ code: 'too_many_members' });
    });
  });
});

describe('listing', () => {
  it('listAppUsersWithRoles groups role rows per user and caps limit, escaping LIKE wildcards', async () => {
    const { runner, calls } = makeFakeRunner(() => [
      { id: 'u1', name: 'Anna', email: 'a@x.dk', directory_user_uuid: DIR, disabled: false, assignment_id: ASG, role_key: 'tt-logleser', scope_org_unit_uuid: null, scope_name: null, include_descendants: true, start_date: null, stop_date: new Date('2030-01-01T00:00:00Z'), assignment_source: 'local', active: true },
      { id: 'u1', name: 'Anna', email: 'a@x.dk', directory_user_uuid: DIR, disabled: false, assignment_id: U1, role_key: 'tt-bruger', scope_org_unit_uuid: null, scope_name: null, include_descendants: true, start_date: null, stop_date: null, assignment_source: 'local', active: true },
      { id: 'u2', name: 'Bo', email: 'b@x.dk', directory_user_uuid: null, disabled: false, assignment_id: null },
    ]);
    const { users, truncated } = await listAppUsersWithRoles({ q: '50%_x', limit: 99999 }, runner);
    expect(truncated).toBe(false);
    expect(users.map((u) => [u.id, u.roles.length])).toEqual([['u1', 2], ['u2', 0]]);
    expect(users[0].roles[0].stopDate).toBe('2030-01-01T00:00:00.000Z');
    // Asks for one row more than the (capped) limit to detect truncation.
    expect(calls[0].params).toEqual(['%50\\%\\_x%', 501]);
    // whitelisted fields only
    expect(Object.keys(users[0]).sort()).toEqual(['directoryUserUuid', 'disabled', 'email', 'id', 'name', 'roles']);
  });

  it('listAppUsersWithRoles drops the extra user and flags truncated when more matched than the limit', async () => {
    const row = (id: string) => ({ id, name: id, email: `${id}@x.dk`, directory_user_uuid: null, disabled: false, assignment_id: null });
    const { runner, calls } = makeFakeRunner(() => [row('a'), row('b'), row('c')]);
    const { users, truncated } = await listAppUsersWithRoles({ limit: 2 }, runner);
    expect(users.map((u) => u.id)).toEqual(['a', 'b']);
    expect(truncated).toBe(true);
    expect(calls[0].params).toEqual([null, 3]);
  });

  it('listOrgUnits with a uuid restriction hides parents outside it and skips the query when empty', async () => {
    const fake = makeFakeRunner(() => [
      { uuid: U2, name: 'B', parent_uuid: U1, source: 'local', member_count: 3 },
      { uuid: U3, name: 'C', parent_uuid: U2, source: 'local', member_count: 0 },
    ]);
    const list = await listOrgUnits({ uuids: [U2, U3] }, fake.runner);
    expect(list.map((u) => [u.uuid, u.parentUuid, u.memberCount])).toEqual([[U2, null, 3], [U3, U2, 0]]);

    const none = makeFakeRunner();
    expect(await listOrgUnits({ uuids: [] }, none.runner)).toEqual([]);
    expect(none.calls).toHaveLength(0);
  });
});

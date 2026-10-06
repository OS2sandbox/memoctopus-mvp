// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// Proves what the mocked tests cannot: atomicity of template + targets + version
// + audit, the row lock under concurrent writers, scope and subtree rules over
// the real org tree, the immutability trigger and the RESTRICT FK. The service
// runs unchanged in a throwaway schema through CentralEnv.schema.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { hasPg, withFreshSchema } from '@/test/pg';
import { makePrincipal } from '@/test/helpers';
import { createRunner, type ClientLike, type SqlResult, type SqlRunner } from '@/lib/authz/pg-runner';

// The audit actor snapshot reads through the app's Drizzle `db`; here it is absent, which record.ts tolerates (null name).
vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));

import { deleteOrgUnit } from '@/lib/authz/access-admin';
import { NotFoundError, VersionConflictError } from '@/lib/authz/access-errors';
import type { Principal } from '@/lib/authz/types';
import {
  archiveCentralTemplate,
  createCentralTemplate,
  getManageableTemplate,
  listManageableTemplates,
  listScopeOrgUnits,
  listVersions,
  restoreCentralTemplate,
  updateCentralTemplate,
  type CentralEnv,
} from './central';

const NOTE = 'Opdateret efter dialog med afdelingen';

/** SqlRunner over the throwaway schema; every transaction gets its own connection so row locks really contend. */
function makeRunner(base: Client, schema: string, opts: { rewritePublic?: boolean } = {}) {
  const rewrite = (sql: string) => (opts.rewritePublic ? sql.replaceAll('public.', `"${schema}".`) : sql);
  const wrap = (c: Client) => ({
    query: (sql: string, params?: readonly unknown[]) =>
      c.query(rewrite(sql), params as unknown[] | undefined) as unknown as Promise<SqlResult<never>>,
  });
  const extra: Client[] = [];
  const runner: SqlRunner = createRunner(wrap(base), async (): Promise<ClientLike> => {
    const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    await c.query(`SET search_path TO "${schema}"`);
    extra.push(c);
    return { ...wrap(c), release: () => void c.end().catch(() => {}) };
  });
  return { runner, close: async () => void (await Promise.allSettled(extra.map((c) => c.end().catch(() => {})))) };
}

async function unit(c: Client, name: string, parent: string | null = null): Promise<string> {
  const r = await c.query(`INSERT INTO org_units (name, parent_uuid, source) VALUES ($1, $2, 'local') RETURNING uuid`, [name, parent]);
  return r.rows[0].uuid;
}

async function user(c: Client, id: string, name = id) {
  await c.query('INSERT INTO users (id, name, email) VALUES ($1, $2, $3)', [id, name, `${id}@example.dk`]);
}

const managerOf = (userId: string, ...roots: string[]): Principal =>
  makePrincipal({
    userId,
    roles: ['tt-skabelonansvarlig'],
    capabilities: ['template.use', 'template.manage'],
    scopes: { 'template.manage': { global: false, roots: roots.map((orgUnitUuid) => ({ orgUnitUuid, includeDescendants: true })) } },
  });

const globalManager = (userId: string): Principal =>
  makePrincipal({
    userId,
    roles: ['tt-administrator'],
    capabilities: ['template.use', 'template.manage'],
    scopes: { 'template.manage': { global: true, roots: [] } },
  });

/**
 * Kommune
 *   A ── A1 ── A11
 *   B ── B1
 */
async function tree(c: Client) {
  const root = await unit(c, 'Kommune');
  const a = await unit(c, 'A', root);
  const a1 = await unit(c, 'A1', a);
  const a11 = await unit(c, 'A11', a1);
  const b = await unit(c, 'B', root);
  const b1 = await unit(c, 'B1', b);
  return { root, a, a1, a11, b, b1 };
}

const count = async (c: Client, table: string, where = 'true', params: unknown[] = []) =>
  (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n as number;

const BASE = { name: 'Dialogmøde', description: 'Til dialogmøder', prompt: 'Skriv et kort referat af mødet.', includeBeslutningspunkter: true };

// Statements that are expected to fail are sent without bind parameters (ids are test-generated uuids,
// inlined): the simple protocol keeps the connection usable for the next assertion on every Postgres,
// including the embedded one some developers use for this lane.
async function expectSqlState(p: Promise<unknown>, state: string) {
  await expect(p).rejects.toMatchObject({ code: state });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.skipIf(!hasPg)('central templates (real Postgres)', () => {
  it('migration 0003 applies after 0000-0002: tables exist, the trigger function exists', () =>
    withFreshSchema(async (c, schema) => {
      const t = await c.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'central_template%' ORDER BY 1`,
        [schema],
      );
      expect(t.rows.map((r) => r.table_name)).toEqual(['central_template_targets', 'central_template_versions', 'central_templates']);
      const f = await c.query(
        `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = 'central_template_versions_guard'`,
        [schema],
      );
      expect(f.rows).toHaveLength(1);
    }));

  describe('create', () => {
    it('writes template, targets, version 1 and the audit event, and returns the admin view', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = makeRunner(c, schema);
        const env: CentralEnv = { schema, runner };
        const t = await tree(c);
        await user(c, 'mgr', 'Mikkel Manager');

        const out = await createCentralTemplate(
          managerOf('mgr', t.a),
          { ...BASE, ownerOrgUnitUuid: t.a, targets: [{ orgUnitUuid: t.a1 }, { orgUnitUuid: t.a, includeDescendants: false }], changeNote: `  ${NOTE}  ` },
          env,
        );

        expect(out).toMatchObject({
          name: 'Dialogmøde',
          prompt: BASE.prompt,
          ownerOrgUnitUuid: t.a,
          status: 'active',
          currentVersion: 1,
          allowUserInstruction: false,
          allowToggleOverrides: false,
          createdByName: 'Mikkel Manager',
        });
        expect([...out.targets].map((x) => x.orgUnitUuid).sort()).toEqual([t.a, t.a1].sort());

        const row = (await c.query('SELECT * FROM central_templates')).rows[0];
        expect(row).not.toHaveProperty('created_by_user_id');
        expect(row.current_version).toBe(1);

        const v = (await c.query('SELECT * FROM central_template_versions')).rows;
        expect(v).toHaveLength(1);
        expect(v[0]).toMatchObject({ version: 1, change_type: 'create', change_note: NOTE, changed_by_user_id: 'mgr', changed_by_name: 'Mikkel Manager' });
        expect(v[0].content).toMatchObject({ name: 'Dialogmøde', prompt: BASE.prompt, includeBeslutningspunkter: true });
        expect(v[0].targets).toHaveLength(2);

        const a = (await c.query(`SELECT * FROM audit_events WHERE event_type = 'central_template.create'`)).rows;
        expect(a).toHaveLength(1);
        expect(a[0]).toMatchObject({
          actor_user_id: 'mgr',
          entity_type: 'central_template',
          entity_id: out.id,
          secondary_entity_type: 'org_unit',
          secondary_entity_id: t.a,
          outcome: 'success',
        });
        expect(a[0].details).toEqual({ version: 1, targetCount: 2 });
        await close();
      }));

    it('is atomic: if the audit write fails nothing of the template, targets or version stays', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = makeRunner(c, schema);
        const failing: SqlRunner = {
          query: (s, p) => runner.query(s, p),
          transaction: (fn) =>
            runner.transaction((tx) =>
              fn({
                query: (sql, params) =>
                  sql.includes('audit_events') ? Promise.reject(new Error('audit down')) : tx.query(sql, params),
              }),
            ),
        };
        const t = await tree(c);
        await expect(
          createCentralTemplate(managerOf('mgr', t.a), { ...BASE, ownerOrgUnitUuid: t.a, targets: [{ orgUnitUuid: t.a1 }], changeNote: NOTE }, { schema, runner: failing }),
        ).rejects.toThrow('audit down');
        expect(await count(c, 'central_templates')).toBe(0);
        expect(await count(c, 'central_template_targets')).toBe(0);
        expect(await count(c, 'central_template_versions')).toBe(0);
        await close();
      }));

    it.each([
      ['too short', 'kort'],
      ['empty', ''],
      ['spaces only', '            '],
      ['9 characters padded with spaces', '   123456789   '],
    ])('rejects a change note that is %s and writes nothing', (_n, changeNote) =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = makeRunner(c, schema);
        const t = await tree(c);
        await expect(
          createCentralTemplate(managerOf('mgr', t.a), { ...BASE, ownerOrgUnitUuid: t.a, changeNote }, { schema, runner }),
        ).rejects.toMatchObject({ code: 'change_note_invalid', message: 'Beskriv ændringen (mindst 10 tegn)' });
        expect(await count(c, 'central_templates')).toBe(0);
        await close();
      }));

    it('the table itself refuses a short or blank note, an unknown change type and a blank prompt (defence in depth)', () =>
      withFreshSchema(async (c) => {
        const t = await tree(c);
        const tpl = (await c.query(`INSERT INTO central_templates (owner_org_unit_uuid, name, prompt) VALUES ($1, 'x', 'p') RETURNING id`, [t.a])).rows[0].id;
        const ins = (changeType: string, note: string) =>
          c.query(`INSERT INTO central_template_versions (template_id, version, change_type, change_note, content, targets) VALUES ('${tpl}', 1, '${changeType}', '${note}', '{}', '[]')`);
        await expectSqlState(ins('create', 'kort'), '23514');
        await expectSqlState(ins('create', '          '), '23514');
        await expectSqlState(ins('delete', 'en lang nok note'), '23514');
        await ins('create', 'en lang nok note');
        await expectSqlState(c.query(`INSERT INTO central_templates (owner_org_unit_uuid, name, prompt) VALUES ('${t.a}', 'x', '   ')`), '23514');
        await expectSqlState(c.query(`INSERT INTO central_templates (owner_org_unit_uuid, name, prompt, status) VALUES ('${t.a}', 'x', 'p', 'deleted')`), '23514');
      }));

    describe('table CHECKs count only meaningful characters (raw SQL, bypassing the app rule)', () => {
      const rep = (cp: number, n = 10) => String.fromCodePoint(cp).repeat(n);
      const padded = (mid: string) => `a${mid.repeat(9)}b`;

      const insertVersion = (c: Client, tpl: string, note: string, version = 1) =>
        c.query(
          `INSERT INTO central_template_versions (template_id, version, change_type, change_note, content, targets) VALUES ($1, $3, 'create', $2, '{}', '[]')`,
          [tpl, note, version],
        );
      const newTemplate = async (c: Client) => {
        const t = await tree(c);
        const r = await c.query(`INSERT INTO central_templates (owner_org_unit_uuid, name, prompt) VALUES ($1, 'x', 'p') RETURNING id`, [t.a]);
        return { tpl: r.rows[0].id as string };
      };

      it.each([
        ['9 NBSP between two letters', padded(String.fromCodePoint(0xa0))],
        ['9 em spaces between two letters', padded(String.fromCodePoint(0x2003))],
        ['9 newlines between two letters', padded('\n')],
        ['10 zero-width spaces', rep(0x200b)],
        ['10 combining grapheme joiners', rep(0x034f)],
        ['10 variation selectors (U+FE0F)', rep(0xfe0f)],
        ['10 Hangul filler U+3164', rep(0x3164)],
        ['10 braille blanks', rep(0x2800)],
        ['10 BOM', rep(0xfeff)],
        ['10 tag characters (U+E0041)', rep(0xe0041)],
        ['10 soft hyphens', rep(0x00ad)],
        ['9 meaningful characters padded with whitespace', `   ${'x'.repeat(9)}   `],
      ])('rejects a change note of %s', (_n, note) =>
        withFreshSchema(async (c) => {
          const { tpl } = await newTemplate(c);
          await expectSqlState(insertVersion(c, tpl, note), '23514');
        }));

      it('accepts a normal note, ten meaningful characters among invisibles, and ten emoji', () =>
        withFreshSchema(async (c) => {
          const { tpl } = await newTemplate(c);
          await insertVersion(c, tpl, 'Rettet tone i afsnit 2', 1);
          await insertVersion(c, tpl, `${'a'.repeat(5)}${rep(0x200b, 20)}${'b'.repeat(5)}`, 2);
          await insertVersion(c, tpl, '😀'.repeat(10), 3);
          await insertVersion(c, tpl, 'æøåÆØÅ æøå æøå', 4);
          expect(await count(c, 'central_template_versions')).toBe(4);
        }));

      it('refuses a note over 2000 characters and accepts exactly 2000', () =>
        withFreshSchema(async (c) => {
          const { tpl } = await newTemplate(c);
          await expectSqlState(insertVersion(c, tpl, 'y'.repeat(2001)), '23514');
          await insertVersion(c, tpl, 'y'.repeat(2000));
        }));

      it.each([
        ['empty', ''],
        ['spaces', '   '],
        ['NBSP and em space', `${String.fromCodePoint(0xa0)}${String.fromCodePoint(0x2003)}`],
        ['zero-width spaces', rep(0x200b, 3)],
        ['Hangul fillers', rep(0x3164, 2)],
        ['variation selectors', rep(0xfe0f, 2)],
      ])('rejects a template name of %s', (_n, name) =>
        withFreshSchema(async (c) => {
          const t = await tree(c);
          await expectSqlState(c.query(`INSERT INTO central_templates (owner_org_unit_uuid, name, prompt) VALUES ($1, $2, 'p')`, [t.a, name]), '23514');
        }));

      it('accepts a one-character name, a Danish name and the 120 character cap, and refuses 121', () =>
        withFreshSchema(async (c) => {
          const t = await tree(c);
          const ins = (name: string) => c.query(`INSERT INTO central_templates (owner_org_unit_uuid, name, prompt) VALUES ($1, $2, 'p')`, [t.a, name]);
          await ins('x');
          await ins('Møde på Å');
          await ins('n'.repeat(120));
          await expectSqlState(ins('n'.repeat(121)), '23514');
        }));

      it('has no created_by_user_id column on central_templates', () =>
        withFreshSchema(async (c, schema) => {
          const r = await c.query(
            `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'central_templates' AND column_name = 'created_by_user_id'`,
            [schema],
          );
          expect(r.rowCount).toBe(0);
        }));
    });

    it('rejects targets outside the owner subtree: sibling, parent, other branch; the owner and descendants are fine', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = makeRunner(c, schema);
        const env: CentralEnv = { schema, runner };
        const t = await tree(c);
        // Global scope, so only the owner-subtree rule can refuse.
        const p = globalManager('mgr');
        const create = (target: string) =>
          createCentralTemplate(p, { ...BASE, ownerOrgUnitUuid: t.a1, targets: [{ orgUnitUuid: target }], changeNote: NOTE }, env);

        await expect(create(t.b)).rejects.toMatchObject({ code: 'target_outside_owner' }); // sibling of the owner's parent
        await expect(create(t.a)).rejects.toMatchObject({ code: 'target_outside_owner' }); // parent: no upward delegation
        await expect(create(t.root)).rejects.toMatchObject({ code: 'target_outside_owner' }); // ancestor
        await expect(create(t.b1)).rejects.toMatchObject({ code: 'target_outside_owner' }); // other branch
        await expect(create('99999999-9999-4999-8999-999999999999')).rejects.toMatchObject({ code: 'target_outside_owner' }); // unknown unit
        expect(await count(c, 'central_templates')).toBe(0);

        const ok = await createCentralTemplate(p, { ...BASE, ownerOrgUnitUuid: t.a1, targets: [{ orgUnitUuid: t.a1 }, { orgUnitUuid: t.a11 }], changeNote: NOTE }, env);
        expect(ok.targets).toHaveLength(2);
        await close();
      }));

    it('refuses an owner unit outside the caller scope or unknown (404) and writes nothing', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = makeRunner(c, schema);
        const env: CentralEnv = { schema, runner };
        const t = await tree(c);
        const mgrA = managerOf('mgr', t.a);
        for (const owner of [t.b, t.root, '99999999-9999-4999-8999-999999999999']) {
          await expect(createCentralTemplate(mgrA, { ...BASE, ownerOrgUnitUuid: owner, changeNote: NOTE }, env)).rejects.toBeInstanceOf(NotFoundError);
        }
        // Without the capability, even a "global-looking" principal is refused (fail closed).
        const plain = makePrincipal({ scopes: { 'template.manage': { global: true, roots: [] } } });
        await expect(createCentralTemplate(plain, { ...BASE, ownerOrgUnitUuid: t.a, changeNote: NOTE }, env)).rejects.toBeInstanceOf(NotFoundError);
        expect(await count(c, 'central_templates')).toBe(0);
        await close();
      }));
  });

  describe('update and optimistic concurrency', () => {
    async function seeded(c: Client, schema: string) {
      const made = makeRunner(c, schema);
      const env: CentralEnv = { schema, runner: made.runner };
      const t = await tree(c);
      await user(c, 'mgr', 'Mikkel Manager');
      await user(c, 'colleague', 'Karen Kollega');
      const mgr = managerOf('mgr', t.a);
      const tpl = await createCentralTemplate(mgr, { ...BASE, ownerOrgUnitUuid: t.a, targets: [{ orgUnitUuid: t.a1 }], changeNote: 'Første version til afdelingen' }, env);
      return { env, t, mgr, tpl, close: made.close };
    }

    it('bumps the version and appends a version row with the full snapshot', () =>
      withFreshSchema(async (c, schema) => {
        const { env, mgr, tpl, close } = await seeded(c, schema);
        const out = await updateCentralTemplate(mgr, tpl.id, { baseVersion: 1, changeNote: NOTE, prompt: 'Skriv et langt referat.', includeDato: true }, env);
        expect(out).toMatchObject({ currentVersion: 2, prompt: 'Skriv et langt referat.', includeDato: true, name: 'Dialogmøde' });

        const v = (await c.query('SELECT * FROM central_template_versions ORDER BY version')).rows;
        expect(v.map((r) => [r.version, r.change_type])).toEqual([[1, 'create'], [2, 'update']]);
        expect(v[1]).toMatchObject({ change_note: NOTE, changed_by_name: 'Mikkel Manager' });
        expect(v[1].content).toMatchObject({ prompt: 'Skriv et langt referat.', includeDato: true, name: 'Dialogmøde', description: 'Til dialogmøder', includeBeslutningspunkter: true });

        const a = (await c.query(`SELECT details FROM audit_events WHERE event_type = 'central_template.update'`)).rows;
        expect(a).toHaveLength(1);
        expect(a[0].details).toEqual({ version: 2, changedFields: ['prompt', 'includeDato'] });
        expect((await c.query('SELECT updated_at > created_at AS touched FROM central_templates')).rows[0].touched).toBe(true);
        await close();
      }));

    it('a stale baseVersion is a conflict carrying the current version, and nothing is written', () =>
      withFreshSchema(async (c, schema) => {
        const { env, mgr, tpl, close } = await seeded(c, schema);
        await updateCentralTemplate(mgr, tpl.id, { baseVersion: 1, changeNote: NOTE, name: 'Nyt navn' }, env);
        const versionsBefore = await count(c, 'central_template_versions');
        const auditBefore = await count(c, 'audit_events');

        const err = await updateCentralTemplate(mgr, tpl.id, { baseVersion: 1, changeNote: NOTE, name: 'Mit navn' }, env).catch((e) => e);
        expect(err).toBeInstanceOf(VersionConflictError);
        expect(err).toMatchObject({ code: 'version_conflict', currentVersion: 2 });

        expect(await count(c, 'central_template_versions')).toBe(versionsBefore);
        expect(await count(c, 'audit_events')).toBe(auditBefore);
        expect((await c.query('SELECT name, current_version FROM central_templates')).rows[0]).toEqual({ name: 'Nyt navn', current_version: 2 });
        await close();
      }));

    it('two concurrent updates with the same baseVersion: exactly one succeeds, the other conflicts', () =>
      withFreshSchema(async (c, schema) => {
        const { env, mgr, tpl, close } = await seeded(c, schema);
        const colleague = managerOf('colleague', (await c.query(`SELECT uuid FROM org_units WHERE name = 'A'`)).rows[0].uuid);
        const results = await Promise.allSettled([
          updateCentralTemplate(mgr, tpl.id, { baseVersion: 1, changeNote: 'Ændring fra den første leder', prompt: 'Prompt fra leder et.' }, env),
          updateCentralTemplate(colleague, tpl.id, { baseVersion: 1, changeNote: 'Ændring fra den anden leder', prompt: 'Prompt fra leder to.' }, env),
        ]);
        const ok = results.filter((r) => r.status === 'fulfilled');
        const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(ok).toHaveLength(1);
        expect(failed).toHaveLength(1);
        expect(failed[0].reason).toBeInstanceOf(VersionConflictError);
        expect(failed[0].reason.currentVersion).toBe(2);

        expect(await count(c, 'central_template_versions')).toBe(2);
        expect(await count(c, 'audit_events', `event_type = 'central_template.update'`)).toBe(1);
        const row = (await c.query('SELECT prompt, current_version FROM central_templates')).rows[0];
        expect(row.current_version).toBe(2);
        const winner = (await c.query(`SELECT change_note, content FROM central_template_versions WHERE version = 2`)).rows[0];
        expect(winner.content.prompt).toBe(row.prompt);
        await close();
      }));

    it('a targets-only change is a retarget (version row and audit event), content stays', () =>
      withFreshSchema(async (c, schema) => {
        const { env, mgr, tpl, t, close } = await seeded(c, schema);
        const out = await updateCentralTemplate(mgr, tpl.id, { baseVersion: 1, changeNote: 'Flyttet til hele afdelingen', targets: [{ orgUnitUuid: t.a, includeDescendants: true }] }, env);
        expect(out.targets).toEqual([{ orgUnitUuid: t.a, includeDescendants: true }]);
        expect(out).toMatchObject({ currentVersion: 2, prompt: BASE.prompt });

        expect((await c.query(`SELECT change_type, targets FROM central_template_versions WHERE version = 2`)).rows[0]).toMatchObject({
          change_type: 'retarget',
          targets: [{ orgUnitUuid: t.a, includeDescendants: true }],
        });
        expect((await c.query(`SELECT details FROM audit_events WHERE event_type = 'central_template.retarget'`)).rows[0].details).toEqual({ version: 2, targetCount: 1 });
        expect(await count(c, 'audit_events', `event_type = 'central_template.update'`)).toBe(0);
        expect(await count(c, 'central_template_targets')).toBe(1);

        // Content plus targets together is an update that names both.
        await updateCentralTemplate(mgr, tpl.id, { baseVersion: 2, changeNote: 'Nyt navn og ingen modtagere', name: 'Andet navn', targets: [] }, env);
        expect((await c.query(`SELECT change_type FROM central_template_versions WHERE version = 3`)).rows[0].change_type).toBe('update');
        expect((await c.query(`SELECT details FROM audit_events WHERE event_type = 'central_template.update'`)).rows[0].details).toEqual({ version: 3, changedFields: ['name', 'targets'] });
        expect(await count(c, 'central_template_targets')).toBe(0);
        await close();
      }));

    it('a new target outside the owner subtree is refused and the old targets stay', () =>
      withFreshSchema(async (c, schema) => {
        const { env, mgr, tpl, t, close } = await seeded(c, schema);
        for (const bad of [t.b, t.root, t.b1]) {
          await expect(updateCentralTemplate(mgr, tpl.id, { baseVersion: 1, changeNote: NOTE, targets: [{ orgUnitUuid: bad }] }, env)).rejects.toMatchObject({ code: 'target_outside_owner' });
        }
        expect((await c.query('SELECT org_unit_uuid FROM central_template_targets')).rows).toEqual([{ org_unit_uuid: t.a1 }]);
        expect(await count(c, 'central_template_versions')).toBe(1);
        await close();
      }));

    it('a colleague whose scope covers the owner unit can edit; the creator is not special', () =>
      withFreshSchema(async (c, schema) => {
        const { env, tpl, t, close } = await seeded(c, schema);
        const colleague = managerOf('colleague', t.a);
        const out = await updateCentralTemplate(colleague, tpl.id, { baseVersion: 1, changeNote: 'Rettet af en kollega', name: 'Kollegas navn' }, env);
        expect(out.name).toBe('Kollegas navn');
        const v = (await c.query('SELECT changed_by_user_id, changed_by_name FROM central_template_versions WHERE version = 2')).rows[0];
        expect(v).toEqual({ changed_by_user_id: 'colleague', changed_by_name: 'Karen Kollega' });
        // A manager scoped to a unit BELOW the owner does not cover the owner.
        await expect(updateCentralTemplate(managerOf('x', t.a1), tpl.id, { baseVersion: 2, changeNote: NOTE, name: 'Nej' }, env)).rejects.toBeInstanceOf(NotFoundError);
        await close();
      }));

    it('version snapshots keep the old content exactly after later edits', () =>
      withFreshSchema(async (c, schema) => {
        const { env, mgr, tpl, t, close } = await seeded(c, schema);
        const v1 = {
          name: 'Dialogmøde',
          description: 'Til dialogmøder',
          prompt: BASE.prompt,
          includeDeltagere: false,
          includeBeslutningspunkter: true,
          includeDagsorden: false,
          includeDato: false,
          allowUserInstruction: false,
          allowToggleOverrides: false,
        };
        await updateCentralTemplate(mgr, tpl.id, { baseVersion: 1, changeNote: NOTE, prompt: 'Helt ny prompt.', allowUserInstruction: true }, env);
        await updateCentralTemplate(mgr, tpl.id, { baseVersion: 2, changeNote: NOTE, name: 'Omdøbt', targets: [{ orgUnitUuid: t.a11 }] }, env);

        const versions = await listVersions(mgr, tpl.id, env);
        expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
        expect(versions[2].content).toEqual(v1);
        expect(versions[2].targets).toEqual([{ orgUnitUuid: t.a1, includeDescendants: true }]);
        expect(versions[1].content).toMatchObject({ prompt: 'Helt ny prompt.', allowUserInstruction: true, name: 'Dialogmøde' });
        expect(versions[0]).toMatchObject({ changeType: 'update', changedByName: 'Mikkel Manager', changeNote: NOTE });
        expect(versions[0].content.name).toBe('Omdøbt');
        expect(versions[0].targets).toEqual([{ orgUnitUuid: t.a11, includeDescendants: true }]);
        await close();
      }));
  });

  describe('scope: 404 outside, never a leak', () => {
    it('a manager of unit A cannot read, list, edit, archive or see the history of a template owned by B', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = makeRunner(c, schema);
        const env: CentralEnv = { schema, runner };
        const t = await tree(c);
        const mgrA = managerOf('a', t.a);
        const mgrB = managerOf('b', t.b);
        const own = await createCentralTemplate(mgrB, { ...BASE, ownerOrgUnitUuid: t.b, changeNote: NOTE }, env);
        const mine = await createCentralTemplate(mgrA, { ...BASE, name: 'Min', ownerOrgUnitUuid: t.a, changeNote: NOTE }, env);

        await expect(getManageableTemplate(mgrA, own.id, env)).rejects.toBeInstanceOf(NotFoundError);
        await expect(listVersions(mgrA, own.id, env)).rejects.toBeInstanceOf(NotFoundError);
        await expect(updateCentralTemplate(mgrA, own.id, { baseVersion: 1, changeNote: NOTE, name: 'X' }, env)).rejects.toBeInstanceOf(NotFoundError);
        await expect(archiveCentralTemplate(mgrA, own.id, { baseVersion: 1, changeNote: NOTE }, env)).rejects.toBeInstanceOf(NotFoundError);
        // Same answer for an id that does not exist: existence is not revealed.
        await expect(getManageableTemplate(mgrA, '99999999-9999-4999-8999-999999999999', env)).rejects.toBeInstanceOf(NotFoundError);
        expect((await c.query('SELECT name, current_version, status FROM central_templates WHERE id = $1', [own.id])).rows[0]).toEqual({ name: 'Dialogmøde', current_version: 1, status: 'active' });

        expect((await listManageableTemplates(mgrA, { status: 'all' }, env)).map((x) => x.id)).toEqual([mine.id]);
        expect((await listManageableTemplates(mgrB, { status: 'all' }, env)).map((x) => x.id)).toEqual([own.id]);
        expect((await listManageableTemplates(globalManager('g'), { status: 'all' }, env)).map((x) => x.id).sort()).toEqual([own.id, mine.id].sort());
        expect(await listManageableTemplates(makePrincipal(), { status: 'all' }, env)).toEqual([]);
        await close();
      }));

    it('a manager scoped to a parent unit manages templates owned by its descendants', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = makeRunner(c, schema);
        const env: CentralEnv = { schema, runner };
        const t = await tree(c);
        const deep = await createCentralTemplate(globalManager('g'), { ...BASE, ownerOrgUnitUuid: t.a11, changeNote: NOTE }, env);
        expect((await getManageableTemplate(managerOf('a', t.a), deep.id, env)).id).toBe(deep.id);
        expect((await listManageableTemplates(managerOf('a', t.a), {}, env)).map((x) => x.id)).toEqual([deep.id]);
        await close();
      }));

    it('lists the scope org units for the pickers: only the subtree, parents above the scope hidden', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = makeRunner(c, schema);
        const env: CentralEnv = { schema, runner };
        const t = await tree(c);
        const scoped = await listScopeOrgUnits(managerOf('a', t.a), env);
        expect(scoped.map((u) => u.name)).toEqual(['A', 'A1', 'A11']);
        expect(scoped.find((u) => u.name === 'A')!.parentUuid).toBeNull();
        expect(scoped.find((u) => u.name === 'A1')!.parentUuid).toBe(t.a);
        expect((await listScopeOrgUnits(globalManager('g'), env)).map((u) => u.name)).toEqual(['A', 'A1', 'A11', 'B', 'B1', 'Kommune']);
        expect(await listScopeOrgUnits(makePrincipal(), env)).toEqual([]);
        await close();
      }));
  });

  describe('archive and restore', () => {
    it('round-trips with a version row each, changes status, and keeps content and targets', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = makeRunner(c, schema);
        const env: CentralEnv = { schema, runner };
        const t = await tree(c);
        const mgr = managerOf('mgr', t.a);
        const tpl = await createCentralTemplate(mgr, { ...BASE, ownerOrgUnitUuid: t.a, targets: [{ orgUnitUuid: t.a1 }], changeNote: NOTE }, env);

        const archived = await archiveCentralTemplate(mgr, tpl.id, { baseVersion: 1, changeNote: 'Bruges ikke længere' }, env);
        expect(archived).toMatchObject({ status: 'archived', currentVersion: 2, prompt: BASE.prompt });
        expect((await listManageableTemplates(mgr, {}, env)).map((x) => x.id)).toEqual([]);
        expect((await listManageableTemplates(mgr, { status: 'archived' }, env)).map((x) => x.id)).toEqual([tpl.id]);

        await expect(updateCentralTemplate(mgr, tpl.id, { baseVersion: 2, changeNote: NOTE, name: 'X' }, env)).rejects.toMatchObject({ code: 'template_archived' });
        await expect(archiveCentralTemplate(mgr, tpl.id, { baseVersion: 2, changeNote: NOTE }, env)).rejects.toMatchObject({ code: 'already_archived' });

        const restored = await restoreCentralTemplate(mgr, tpl.id, { baseVersion: 2, changeNote: 'Skal bruges igen' }, env);
        expect(restored).toMatchObject({ status: 'active', currentVersion: 3 });
        await expect(restoreCentralTemplate(mgr, tpl.id, { baseVersion: 3, changeNote: NOTE }, env)).rejects.toMatchObject({ code: 'not_archived' });

        const versions = await listVersions(mgr, tpl.id, env);
        expect(versions.map((v) => [v.version, v.changeType, v.changeNote])).toEqual([
          [3, 'restore', 'Skal bruges igen'],
          [2, 'archive', 'Bruges ikke længere'],
          [1, 'create', NOTE],
        ]);
        expect(versions[1].targets).toEqual([{ orgUnitUuid: t.a1, includeDescendants: true }]);
        expect((await c.query(`SELECT event_type, details FROM audit_events WHERE event_type IN ('central_template.archive','central_template.restore') ORDER BY id`)).rows).toEqual([
          { event_type: 'central_template.archive', details: { version: 2 } },
          { event_type: 'central_template.restore', details: { version: 3 } },
        ]);
        // No hard delete exists in the service: the row is still there.
        expect(await count(c, 'central_templates')).toBe(1);
        await close();
      }));
  });

  describe('the changelog is append-only', () => {
    async function withVersion(c: Client) {
      const t = await tree(c);
      const id = (await c.query(`INSERT INTO central_templates (owner_org_unit_uuid, name, prompt) VALUES ($1, 'x', 'p') RETURNING id`, [t.a])).rows[0].id;
      await c.query(`INSERT INTO central_template_versions (template_id, version, change_type, change_note, content, targets) VALUES ($1, 1, 'create', 'en lang nok note', '{}', '[]')`, [id]);
      return { t, id };
    }

    it('refuses UPDATE, DELETE and TRUNCATE with SQLSTATE 55000, and a template delete that would cascade', () =>
      withFreshSchema(async (c) => {
        const { id } = await withVersion(c);
        await expectSqlState(c.query(`UPDATE central_template_versions SET change_note = 'noget helt andet her'`), '55000');
        await expectSqlState(c.query(`UPDATE central_template_versions SET content = '{"x":1}'`), '55000');
        await expectSqlState(c.query('DELETE FROM central_template_versions'), '55000');
        await expectSqlState(c.query('TRUNCATE central_template_versions'), '55000');
        // There is no prune bypass, not even for the setting audit_events honours.
        await c.query(`SELECT set_config('audit.allow_prune', 'on', false)`);
        await expectSqlState(c.query('DELETE FROM central_template_versions'), '55000');
        // A hard delete of the template would cascade into the changelog and is refused too.
        await expectSqlState(c.query(`DELETE FROM central_templates WHERE id = '${id}'`), '55000');
        expect(await count(c, 'central_template_versions')).toBe(1);
        expect(await count(c, 'central_templates')).toBe(1);
      }));

    it('still allows INSERT, and one version number per template (UNIQUE)', () =>
      withFreshSchema(async (c) => {
        const { id } = await withVersion(c);
        await c.query(`INSERT INTO central_template_versions (template_id, version, change_type, change_note, content, targets) VALUES ($1, 2, 'update', 'en lang nok note', '{}', '[]')`, [id]);
        await expectSqlState(
          c.query(`INSERT INTO central_template_versions (template_id, version, change_type, change_note, content, targets) VALUES ('${id}', 2, 'update', 'en lang nok note', '{}', '[]')`),
          '23505',
        );
      }));
  });

  describe('org unit deletion', () => {
    it('is RESTRICTed by the FK while the unit owns a template, even an archived one', () =>
      withFreshSchema(async (c) => {
        const t = await tree(c);
        await c.query(`INSERT INTO central_templates (owner_org_unit_uuid, name, prompt, status) VALUES ($1, 'x', 'p', 'archived')`, [t.b1]);
        // ON DELETE RESTRICT raises restrict_violation (23001), not foreign_key_violation (23503).
        await expectSqlState(c.query(`DELETE FROM org_units WHERE uuid = '${t.b1}'`), '23001');
        await c.query('DELETE FROM org_units WHERE uuid = $1', [t.a11]);
      }));

    it('deleteOrgUnit answers 409 in Danish instead of a raw FK error, and the unit survives', () =>
      withFreshSchema(async (c, schema) => {
        vi.stubEnv('ACCESS_SOURCE', 'local');
        try {
          const { runner, close } = makeRunner(c, schema, { rewritePublic: true });
          const t = await tree(c);
          await createCentralTemplate(
            globalManager('g'),
            { ...BASE, ownerOrgUnitUuid: t.b1, changeNote: NOTE },
            { schema, runner },
          );
          await expect(deleteOrgUnit(t.b1, 'admin', runner)).rejects.toMatchObject({
            name: 'ConflictError',
            code: 'has_central_templates',
            message: expect.stringContaining('centrale skabeloner'),
          });
          expect(await count(c, 'org_units', 'uuid = $1', [t.b1])).toBe(1);
          // A unit without templates is still deletable.
          await deleteOrgUnit(t.a11, 'admin', runner);
          expect(await count(c, 'org_units', 'uuid = $1', [t.a11])).toBe(0);
          await close();
        } finally {
          vi.unstubAllEnvs();
        }
      }));

    it('deleting a TARGET unit removes the target row only; the template and its history remain', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = makeRunner(c, schema);
        const t = await tree(c);
        const tpl = await createCentralTemplate(
          globalManager('g'),
          { ...BASE, ownerOrgUnitUuid: t.a, targets: [{ orgUnitUuid: t.a11 }], changeNote: NOTE },
          { schema, runner },
        );
        await c.query('DELETE FROM org_units WHERE uuid = $1', [t.a11]);
        expect(await count(c, 'central_template_targets', 'template_id = $1', [tpl.id])).toBe(0);
        expect(await count(c, 'central_templates')).toBe(1);
        // The snapshot still names the unit that existed then.
        expect((await c.query('SELECT targets FROM central_template_versions')).rows[0].targets).toEqual([{ orgUnitUuid: t.a11, includeDescendants: true }]);
        await close();
      }));
  });

  describe('audit stays metadata only', () => {
    it('no name, description, prompt or change note appears in any audit column', () =>
      withFreshSchema(async (c, schema) => {
        const { runner, close } = makeRunner(c, schema);
        const env: CentralEnv = { schema, runner };
        const t = await tree(c);
        const mgr = managerOf('mgr', t.a);
        const secret = { name: 'Hemmeligt navn', prompt: 'Hemmelig promptTekst', note: 'Hemmelig ændringsnote her' };
        const tpl = await createCentralTemplate(mgr, { ...BASE, name: secret.name, prompt: secret.prompt, ownerOrgUnitUuid: t.a, changeNote: secret.note }, env);
        await updateCentralTemplate(mgr, tpl.id, { baseVersion: 1, changeNote: secret.note, prompt: 'Hemmelig promptTekst 2' }, env);
        await archiveCentralTemplate(mgr, tpl.id, { baseVersion: 2, changeNote: secret.note }, env);
        await restoreCentralTemplate(mgr, tpl.id, { baseVersion: 3, changeNote: secret.note }, env);

        const dump = JSON.stringify((await c.query(`SELECT * FROM audit_events WHERE event_type LIKE 'central_template.%'`)).rows);
        expect((await c.query(`SELECT count(*)::int AS n FROM audit_events WHERE event_type LIKE 'central_template.%'`)).rows[0].n).toBe(4);
        for (const s of ['Hemmeligt', 'Hemmelig prompt', 'promptTekst', 'ændringsnote']) expect(dump).not.toContain(s);
        await close();
      }));
  });
});

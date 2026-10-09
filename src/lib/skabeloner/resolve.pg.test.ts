// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// Proves the audience rule over a real org tree: who receives a central template
// (target unit, descendants only when include_descendants, linked and not
// disabled), that archived templates vanish, and that bad data (a parent cycle)
// or a very large tree cannot hang or multiply the query.
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import { hasPg, withFreshSchema } from '@/test/pg';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));

import { MAX_ORG_DEPTH } from '@/lib/authz/scope';
import { listCentralForUser, resolveCentralTemplate, type ResolveEnv } from './resolve';

const PROMPT = 'HEMMELIG-PROMPT-TEKST';

function envOf(c: Client, schema: string, claimsMaxSeconds: number | null = null) {
  const calls: string[] = [];
  const env: ResolveEnv = {
    schema,
    claimsMaxSeconds,
    query: (text, params) => {
      calls.push(text);
      return c.query(text, params as unknown[]) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>;
    },
  };
  return { env, calls };
}

async function unit(c: Client, name: string, parent: string | null = null): Promise<string> {
  const r = await c.query(`INSERT INTO org_units (name, parent_uuid, source) VALUES ($1, $2, 'local') RETURNING uuid`, [name, parent]);
  return r.rows[0].uuid;
}

/** An app user, optionally linked to a directory user that is a member of the given units. */
async function person(c: Client, id: string, opts: { units?: string[]; linked?: boolean; disabled?: boolean } = {}) {
  await c.query('INSERT INTO users (id, name, email) VALUES ($1, $1, $2)', [id, `${id}@example.dk`]);
  if (opts.linked === false) return;
  const d = await c.query(
    `INSERT INTO directory_users (name, source, disabled, app_user_id) VALUES ($1, 'local', $2, $1) RETURNING uuid`,
    [id, opts.disabled ?? false],
  );
  for (const u of opts.units ?? []) {
    await c.query('INSERT INTO org_unit_members (directory_user_uuid, org_unit_uuid) VALUES ($1, $2)', [d.rows[0].uuid, u]);
  }
}

async function template(
  c: Client,
  owner: string | null,
  name: string,
  targets: Array<{ unit: string; descendants?: boolean }>,
  opts: { status?: 'active' | 'archived'; version?: number } = {},
): Promise<string> {
  const r = await c.query(
    `INSERT INTO central_templates (owner_org_unit_uuid, name, prompt, status, current_version)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [owner, name, PROMPT, opts.status ?? 'active', opts.version ?? 1],
  );
  for (const t of targets) {
    await c.query(
      'INSERT INTO central_template_targets (template_id, org_unit_uuid, include_descendants) VALUES ($1, $2, $3)',
      [r.rows[0].id, t.unit, t.descendants ?? true],
    );
  }
  return r.rows[0].id;
}

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

const ids = async (c: Client, schema: string, userId: string) => {
  const { env } = envOf(c, schema);
  return (await listCentralForUser(userId, env)).map((s) => s.id).sort();
};

describe.skipIf(!hasPg)('central template audience (real Postgres)', () => {
  it('a member of the target unit receives it, with or without include_descendants', () =>
    withFreshSchema(async (c, schema) => {
      const t = await tree(c);
      const incl = await template(c, t.a, 'Med', [{ unit: t.a1, descendants: true }]);
      const excl = await template(c, t.a, 'Uden', [{ unit: t.a1, descendants: false }]);
      await person(c, 'u-a1', { units: [t.a1] });
      expect(await ids(c, schema, 'u-a1')).toEqual([incl, excl].sort());
    }));

  it('a member of a DESCENDANT receives it only when the target includes descendants', () =>
    withFreshSchema(async (c, schema) => {
      const t = await tree(c);
      const incl = await template(c, t.a, 'Med', [{ unit: t.a, descendants: true }]);
      await template(c, t.a, 'Uden', [{ unit: t.a, descendants: false }]);
      await person(c, 'u-deep', { units: [t.a11] });
      expect(await ids(c, schema, 'u-deep')).toEqual([incl]);

      const { env } = envOf(c, schema);
      expect(await resolveCentralTemplate('u-deep', incl, env)).toMatchObject({ id: incl, prompt: PROMPT, version: 1 });
    }));

  it('members of a sibling, a parent or another branch receive nothing', () =>
    withFreshSchema(async (c, schema) => {
      const t = await tree(c);
      const tpl = await template(c, t.a, 'Kun A1', [{ unit: t.a1, descendants: true }]);
      await person(c, 'u-sibling', { units: [t.a] }); // parent of the target
      await person(c, 'u-other', { units: [t.b1] });
      await person(c, 'u-root', { units: [t.root] });
      await person(c, 'u-self-sibling', { units: [await unit(c, 'A2', t.a)] });
      for (const u of ['u-sibling', 'u-other', 'u-root', 'u-self-sibling']) {
        expect(await ids(c, schema, u)).toEqual([]);
        const { env } = envOf(c, schema);
        expect(await resolveCentralTemplate(u, tpl, env)).toBeNull();
      }
    }));

  it('an unlinked app user and a disabled directory user receive nothing (fail closed)', () =>
    withFreshSchema(async (c, schema) => {
      const t = await tree(c);
      const tpl = await template(c, t.a, 'Alle i A', [{ unit: t.a, descendants: true }]);
      await person(c, 'u-unlinked', { linked: false });
      await person(c, 'u-disabled', { units: [t.a1], disabled: true });
      await person(c, 'u-ok', { units: [t.a1] });
      expect(await ids(c, schema, 'u-unlinked')).toEqual([]);
      expect(await ids(c, schema, 'u-disabled')).toEqual([]);
      expect(await ids(c, schema, 'no-such-user')).toEqual([]);
      expect(await ids(c, schema, 'u-ok')).toEqual([tpl]);
      const { env } = envOf(c, schema);
      expect(await resolveCentralTemplate('u-disabled', tpl, env)).toBeNull();
      expect(await resolveCentralTemplate('u-unlinked', tpl, env)).toBeNull();
    }));

  it('a user in several units receives the union, each template once', () =>
    withFreshSchema(async (c, schema) => {
      const t = await tree(c);
      const viaA = await template(c, t.root, 'Via A', [{ unit: t.a, descendants: true }]);
      const viaB = await template(c, t.root, 'Via B', [{ unit: t.b1, descendants: false }]);
      const both = await template(c, t.root, 'Begge', [{ unit: t.a1, descendants: true }, { unit: t.b, descendants: true }]);
      await template(c, t.root, 'Ingen', [{ unit: t.a11, descendants: false }]);
      await person(c, 'u-multi', { units: [t.a1, t.b1] });
      expect(await ids(c, schema, 'u-multi')).toEqual([viaA, viaB, both].sort());
    }));

  it('archived templates are neither listed nor resolvable; restoring brings them back with the stored version', () =>
    withFreshSchema(async (c, schema) => {
      const t = await tree(c);
      const tpl = await template(c, t.a, 'Arkiveret', [{ unit: t.a, descendants: true }], { status: 'archived', version: 5 });
      await person(c, 'u-1', { units: [t.a] });
      const { env } = envOf(c, schema);
      expect(await ids(c, schema, 'u-1')).toEqual([]);
      expect(await resolveCentralTemplate('u-1', tpl, env)).toBeNull();

      await c.query(`UPDATE central_templates SET status = 'active' WHERE id = $1`, [tpl]);
      expect(await ids(c, schema, 'u-1')).toEqual([tpl]);
      expect(await resolveCentralTemplate('u-1', tpl, env)).toMatchObject({ version: 5 });
    }));

  it('a template with zero targets reaches nobody', () =>
    withFreshSchema(async (c, schema) => {
      const t = await tree(c);
      await template(c, t.a, 'Ingen modtagere', []);
      await person(c, 'u-1', { units: [t.a] });
      expect(await ids(c, schema, 'u-1')).toEqual([]);
    }));

  it('the summary never carries the prompt; resolve is the only place that reads it', () =>
    withFreshSchema(async (c, schema) => {
      const t = await tree(c);
      await template(c, t.a, 'T', [{ unit: t.a, descendants: true }]);
      await person(c, 'u-1', { units: [t.a] });
      const { env, calls } = envOf(c, schema);
      const list = await listCentralForUser('u-1', env);
      expect(list).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain(PROMPT);
      expect(calls.every((q) => !/\bprompt\b/.test(q))).toBe(true);
    }));

  it('a malformed id never reaches Postgres (no uuid cast error)', () =>
    withFreshSchema(async (c, schema) => {
      const { env, calls } = envOf(c, schema);
      expect(await resolveCentralTemplate('u-1', 'not-a-uuid', env)).toBeNull();
      expect(calls).toHaveLength(0);
    }));

  it('an org-tree cycle in bad data terminates and still resolves membership', () =>
    withFreshSchema(async (c, schema) => {
      const x = await unit(c, 'X');
      const y = await unit(c, 'Y', x);
      await c.query('UPDATE org_units SET parent_uuid = $1 WHERE uuid = $2', [y, x]); // X -> Y -> X
      const outside = await unit(c, 'Udenfor');
      const viaCycle = await template(c, x, 'I cyklen', [{ unit: x, descendants: true }]);
      await template(c, outside, 'Andet sted', [{ unit: outside, descendants: true }]);
      await person(c, 'u-cycle', { units: [y] });
      expect(await ids(c, schema, 'u-cycle')).toEqual([viaCycle]);
      const { env } = envOf(c, schema);
      expect(await resolveCentralTemplate('u-cycle', viaCycle, env)).not.toBeNull();
    }));

  it('a self-parented unit terminates', () =>
    withFreshSchema(async (c, schema) => {
      const x = await unit(c, 'Selv');
      await c.query('UPDATE org_units SET parent_uuid = uuid WHERE uuid = $1', [x]);
      const tpl = await template(c, x, 'T', [{ unit: x, descendants: true }]);
      await person(c, 'u-1', { units: [x] });
      expect(await ids(c, schema, 'u-1')).toEqual([tpl]);
    }));

  it(`ancestors deeper than MAX_ORG_DEPTH (${MAX_ORG_DEPTH}) are not covered (fail closed)`, () =>
    withFreshSchema(async (c, schema) => {
      const chain: string[] = [];
      for (let i = 0; i < MAX_ORG_DEPTH + 6; i++) chain.push(await unit(c, `N${i}`, chain[i - 1] ?? null));
      const leaf = chain[chain.length - 1];
      const tooFar = await template(c, chain[0], 'Rod', [{ unit: chain[0], descendants: true }]);
      const near = await template(c, chain[chain.length - 10], 'Nær', [{ unit: chain[chain.length - 10], descendants: true }]);
      await person(c, 'u-leaf', { units: [leaf] });
      const got = await ids(c, schema, 'u-leaf');
      expect(got).toContain(near);
      expect(got).not.toContain(tooFar);
    }));

  describe('owner-subtree re-check at read time', () => {
    const move = (c: Client, unitUuid: string, parent: string | null) =>
      c.query('UPDATE org_units SET parent_uuid = $1 WHERE uuid = $2', [parent, unitUuid]);

    it('baseline: a target inside the owner subtree delivers to its members and (included) descendants', () =>
      withFreshSchema(async (c, schema) => {
        const t = await tree(c);
        const tpl = await template(c, t.a, 'Baseline', [{ unit: t.a1, descendants: true }]);
        await person(c, 'u-a1', { units: [t.a1] });
        await person(c, 'u-a11', { units: [t.a11] });
        expect(await ids(c, schema, 'u-a1')).toEqual([tpl]);
        expect(await ids(c, schema, 'u-a11')).toEqual([tpl]);
        const { env } = envOf(c, schema);
        expect(await resolveCentralTemplate('u-a11', tpl, env)).toMatchObject({ id: tpl, prompt: PROMPT });
      }));

    it('a target re-parented OUTSIDE the owner subtree stops delivering, and delivers again when moved back', () =>
      withFreshSchema(async (c, schema) => {
        const t = await tree(c);
        const tpl = await template(c, t.a, 'Drift', [{ unit: t.a1, descendants: false }]);
        await person(c, 'u-a1', { units: [t.a1] });
        const { env } = envOf(c, schema);
        expect(await ids(c, schema, 'u-a1')).toEqual([tpl]);

        await move(c, t.a1, t.b); // A1 now sits under B, outside owner A
        expect(await ids(c, schema, 'u-a1')).toEqual([]);
        expect(await resolveCentralTemplate('u-a1', tpl, env)).toBeNull();

        await move(c, t.a1, t.a);
        expect(await ids(c, schema, 'u-a1')).toEqual([tpl]);
        expect(await resolveCentralTemplate('u-a1', tpl, env)).toMatchObject({ id: tpl });
      }));

    it('restoring an archived template does not re-activate a drifted target', () =>
      withFreshSchema(async (c, schema) => {
        const t = await tree(c);
        const tpl = await template(c, t.a, 'Arkiv', [{ unit: t.a1, descendants: true }], { status: 'archived' });
        await person(c, 'u-a1', { units: [t.a1] });
        await move(c, t.a1, t.b);
        await c.query(`UPDATE central_templates SET status = 'active' WHERE id = $1`, [tpl]);
        expect(await ids(c, schema, 'u-a1')).toEqual([]);
      }));

    it('a target equal to the owner unit delivers', () =>
      withFreshSchema(async (c, schema) => {
        const t = await tree(c);
        const tpl = await template(c, t.a, 'Ejer', [{ unit: t.a, descendants: false }]);
        await person(c, 'u-a', { units: [t.a] });
        expect(await ids(c, schema, 'u-a')).toEqual([tpl]);
      }));

    it(`a target ${MAX_ORG_DEPTH} levels below the owner delivers; one level further does not`, () =>
      withFreshSchema(async (c, schema) => {
        const chain: string[] = [];
        for (let i = 0; i <= MAX_ORG_DEPTH + 1; i++) chain.push(await unit(c, `D${i}`, chain[i - 1] ?? null));
        const atCap = await template(c, chain[0], 'Ved grænsen', [{ unit: chain[MAX_ORG_DEPTH], descendants: false }]);
        const beyond = await template(c, chain[0], 'Over grænsen', [{ unit: chain[MAX_ORG_DEPTH + 1], descendants: false }]);
        await person(c, 'u-cap', { units: [chain[MAX_ORG_DEPTH]] });
        await person(c, 'u-beyond', { units: [chain[MAX_ORG_DEPTH + 1]] });
        expect(await ids(c, schema, 'u-cap')).toEqual([atCap]);
        expect(await ids(c, schema, 'u-beyond')).toEqual([]);
        const { env } = envOf(c, schema);
        expect(await resolveCentralTemplate('u-beyond', beyond, env)).toBeNull();
      }), 60_000);

    it('a parent cycle that never reaches the owner terminates and delivers nothing', () =>
      withFreshSchema(async (c, schema) => {
        const owner = await unit(c, 'Ejer');
        const x = await unit(c, 'X', owner);
        const y = await unit(c, 'Y', x);
        await move(c, x, y); // X -> Y -> X, detached from the owner
        const tpl = await template(c, owner, 'Cyklisk', [{ unit: y, descendants: true }]);
        await person(c, 'u-cycle', { units: [y] });
        await person(c, 'u-below', { units: [await unit(c, 'Z', x)] });
        expect(await ids(c, schema, 'u-cycle')).toEqual([]);
        expect(await ids(c, schema, 'u-below')).toEqual([]);
        const { env } = envOf(c, schema);
        expect(await resolveCentralTemplate('u-cycle', tpl, env)).toBeNull();
      }));

    it('include_descendants on a drifted target does not deliver to its descendants either', () =>
      withFreshSchema(async (c, schema) => {
        const t = await tree(c);
        const tpl = await template(c, t.a, 'Drift med børn', [{ unit: t.a1, descendants: true }]);
        await person(c, 'u-a1', { units: [t.a1] });
        await person(c, 'u-a11', { units: [t.a11] });
        await move(c, t.a1, t.b);
        expect(await ids(c, schema, 'u-a1')).toEqual([]);
        expect(await ids(c, schema, 'u-a11')).toEqual([]);
        const { env } = envOf(c, schema);
        expect(await resolveCentralTemplate('u-a11', tpl, env)).toBeNull();
      }));

    it('with several targets, valid ones still deliver while the drifted one does not', () =>
      withFreshSchema(async (c, schema) => {
        const t = await tree(c);
        const a2 = await unit(c, 'A2', t.a);
        const tpl = await template(c, t.a, 'Flere', [
          { unit: t.a1, descendants: true },
          { unit: a2, descendants: true },
        ]);
        await person(c, 'u-a1', { units: [t.a1] });
        await person(c, 'u-a2', { units: [a2] });
        await person(c, 'u-both', { units: [t.a1, a2] });
        await move(c, t.a1, t.b);
        expect(await ids(c, schema, 'u-a1')).toEqual([]);
        expect(await ids(c, schema, 'u-a2')).toEqual([tpl]);
        expect(await ids(c, schema, 'u-both')).toEqual([tpl]);
      }));

    it('stays ONE query per call', () =>
      withFreshSchema(async (c, schema) => {
        const t = await tree(c);
        const tpl = await template(c, t.a, 'En', [{ unit: t.a1, descendants: true }]);
        await person(c, 'u-1', { units: [t.a11] });
        const { env, calls } = envOf(c, schema);
        await listCentralForUser('u-1', env);
        await resolveCentralTemplate('u-1', tpl, env);
        expect(calls).toHaveLength(2);
      }));
  });

  it('stays ONE query and fast on a tree of a few thousand units', () =>
    withFreshSchema(async (c, schema) => {
      const root = await unit(c, 'Rod');
      const kids: string[] = [];
      for (let i = 0; i < 50; i++) kids.push(await unit(c, `K${i}`, root));
      // 50 x 60 grandchildren in one statement each.
      let leaf = '';
      for (const k of kids) {
        const r = await c.query(
          `INSERT INTO org_units (name, parent_uuid, source) SELECT 'G' || g, $1::uuid, 'local' FROM generate_series(1, 60) g RETURNING uuid`,
          [k],
        );
        leaf = r.rows[0].uuid;
      }
      const all = await template(c, root, 'Hele kommunen', [{ unit: root, descendants: true }]);
      const other = await template(c, kids[1], 'Anden gren', [{ unit: kids[1], descendants: true }]);
      await person(c, 'u-leaf', { units: [leaf] });

      const { env, calls } = envOf(c, schema);
      const t0 = Date.now();
      const out = (await listCentralForUser('u-leaf', env)).map((s) => s.id);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(calls).toHaveLength(1);
      expect(out).toContain(all);
      expect(out).not.toContain(other);
    }), 60_000);

  describe('by role or group (claims mode)', () => {
    const MAX = 8 * 3600;

    async function catalogue(c: Client, kind: 'role' | 'group', identifier: string, active = true) {
      await c.query(`INSERT INTO external_roles (kind, identifier, name, source, active) VALUES ($1, $2, $2, 'config', $3)`, [kind, identifier, active]);
    }
    /** The person's latest IdP login claimed this catalogue value `ageSeconds` ago. */
    async function holds(c: Client, userId: string, kind: 'role' | 'group', identifier: string, ageSeconds = 0) {
      await c.query(
        `INSERT INTO user_external_roles (user_id, kind, identifier, seen_at) VALUES ($1, $2, $3, now() - make_interval(secs => $4))`,
        [userId, kind, identifier, ageSeconds],
      );
    }
    async function target(c: Client, templateId: string, kind: 'role' | 'group', identifier: string) {
      await c.query('INSERT INTO central_template_principal_targets (template_id, kind, identifier) VALUES ($1, $2, $3)', [templateId, kind, identifier]);
    }
    const idsFor = async (c: Client, schema: string, userId: string, max: number | null = MAX) =>
      (await listCentralForUser(userId, envOf(c, schema, max).env)).map((x) => x.id).sort();

    /** An organisation-wide template (no owner) targeted at one role. */
    async function wide(c: Client, name = 'Org-bred') {
      await catalogue(c, 'role', 'sagsbehandler');
      const id = await template(c, null, name, []);
      await target(c, id, 'role', 'sagsbehandler');
      return id;
    }

    it('a person holding the role receives an org-wide template with no org units at all; the prompt only to the server resolver', () =>
      withFreshSchema(async (c, schema) => {
        const tpl = await wide(c);
        await person(c, 'u-yes');
        await holds(c, 'u-yes', 'role', 'sagsbehandler');
        await person(c, 'u-no');
        expect(await idsFor(c, schema, 'u-yes')).toEqual([tpl]);
        expect(JSON.stringify(await listCentralForUser('u-yes', envOf(c, schema, MAX).env))).not.toContain(PROMPT);
        expect(await resolveCentralTemplate('u-yes', tpl, envOf(c, schema, MAX).env)).toMatchObject({ id: tpl, prompt: PROMPT });
        // A non-recipient gets the same null as for an unknown id.
        expect(await idsFor(c, schema, 'u-no')).toEqual([]);
        expect(await resolveCentralTemplate('u-no', tpl, envOf(c, schema, MAX).env)).toBeNull();
        expect(await resolveCentralTemplate('u-no', '00000000-0000-4000-8000-000000000000', envOf(c, schema, MAX).env)).toBeNull();
      }));

    it('a role and a group with the same identifier are different targets', () =>
      withFreshSchema(async (c, schema) => {
        await catalogue(c, 'role', 'x');
        await catalogue(c, 'group', 'x');
        const tpl = await template(c, null, 'Kun rollen', []);
        await target(c, tpl, 'role', 'x');
        await person(c, 'u-group');
        await holds(c, 'u-group', 'group', 'x');
        await person(c, 'u-role');
        await holds(c, 'u-role', 'role', 'x');
        expect(await idsFor(c, schema, 'u-group')).toEqual([]);
        expect(await idsFor(c, schema, 'u-role')).toEqual([tpl]);
      }));

    it('the claim row must be fresh (ROLE_CLAIMS_MAX_SECONDS): a stale snapshot grants nothing, at the second', () =>
      withFreshSchema(async (c, schema) => {
        const tpl = await wide(c);
        await person(c, 'u-stale');
        await holds(c, 'u-stale', 'role', 'sagsbehandler', MAX + 5);
        await person(c, 'u-fresh');
        await holds(c, 'u-fresh', 'role', 'sagsbehandler', MAX - 60);
        expect(await idsFor(c, schema, 'u-stale')).toEqual([]);
        expect(await resolveCentralTemplate('u-stale', tpl, envOf(c, schema, MAX).env)).toBeNull();
        expect(await idsFor(c, schema, 'u-fresh')).toEqual([tpl]);
        // A shorter limit retires the same row.
        expect(await idsFor(c, schema, 'u-fresh', 30)).toEqual([]);
      }));

    it('the branch is off when the freshness is null (not claims mode), even for a holder', () =>
      withFreshSchema(async (c, schema) => {
        const tpl = await wide(c);
        await person(c, 'u-yes');
        await holds(c, 'u-yes', 'role', 'sagsbehandler');
        expect(await idsFor(c, schema, 'u-yes', null)).toEqual([]);
        expect(await resolveCentralTemplate('u-yes', tpl, envOf(c, schema, null).env)).toBeNull();
      }));

    it('an unlinked or disabled person receives nothing, whatever role rows exist (fail closed)', () =>
      withFreshSchema(async (c, schema) => {
        const tpl = await wide(c);
        await person(c, 'u-unlinked', { linked: false });
        await holds(c, 'u-unlinked', 'role', 'sagsbehandler');
        await person(c, 'u-disabled', { disabled: true });
        await holds(c, 'u-disabled', 'role', 'sagsbehandler');
        expect(await idsFor(c, schema, 'u-unlinked')).toEqual([]);
        expect(await idsFor(c, schema, 'u-disabled')).toEqual([]);
        expect(await resolveCentralTemplate('u-disabled', tpl, envOf(c, schema, MAX).env)).toBeNull();
      }));

    it('a withdrawn (inactive) catalogue entry reaches nobody at once, and reactivating brings it back', () =>
      withFreshSchema(async (c, schema) => {
        const tpl = await wide(c);
        await person(c, 'u-yes');
        await holds(c, 'u-yes', 'role', 'sagsbehandler');
        await c.query(`UPDATE external_roles SET active = false WHERE identifier = 'sagsbehandler'`);
        expect(await idsFor(c, schema, 'u-yes')).toEqual([]);
        await c.query(`UPDATE external_roles SET active = true WHERE identifier = 'sagsbehandler'`);
        expect(await idsFor(c, schema, 'u-yes')).toEqual([tpl]);
      }));

    it('archiving, retargeting and a role that left the person at their next login each withdraw access', () =>
      withFreshSchema(async (c, schema) => {
        const tpl = await wide(c);
        await person(c, 'u-yes');
        await holds(c, 'u-yes', 'role', 'sagsbehandler');
        expect(await idsFor(c, schema, 'u-yes')).toEqual([tpl]);

        await c.query(`UPDATE central_templates SET status = 'archived' WHERE id = $1`, [tpl]);
        expect(await idsFor(c, schema, 'u-yes')).toEqual([]);
        expect(await resolveCentralTemplate('u-yes', tpl, envOf(c, schema, MAX).env)).toBeNull();
        await c.query(`UPDATE central_templates SET status = 'active' WHERE id = $1`, [tpl]);
        expect(await idsFor(c, schema, 'u-yes')).toEqual([tpl]);

        await c.query('DELETE FROM central_template_principal_targets WHERE template_id = $1', [tpl]);
        expect(await idsFor(c, schema, 'u-yes')).toEqual([]);
        await target(c, tpl, 'role', 'sagsbehandler');
        expect(await idsFor(c, schema, 'u-yes')).toEqual([tpl]);

        await c.query(`DELETE FROM user_external_roles WHERE user_id = 'u-yes'`);
        expect(await idsFor(c, schema, 'u-yes')).toEqual([]);
      }));

    it('either branch is enough, and a template matched by both is listed once', () =>
      withFreshSchema(async (c, schema) => {
        const t = await tree(c);
        await catalogue(c, 'role', 'r');
        const both = await template(c, t.a, 'Begge', [{ unit: t.a1 }]);
        await target(c, both, 'role', 'r');
        const unitOnly = await template(c, t.a, 'Kun enhed', [{ unit: t.a1 }]);
        const roleOnly = await template(c, null, 'Kun rolle', []);
        await target(c, roleOnly, 'role', 'r');

        await person(c, 'u-unit', { units: [t.a1] });
        await person(c, 'u-role');
        await holds(c, 'u-role', 'role', 'r');
        await person(c, 'u-both', { units: [t.a1] });
        await holds(c, 'u-both', 'role', 'r');

        expect(await idsFor(c, schema, 'u-unit')).toEqual([both, unitOnly].sort());
        expect(await idsFor(c, schema, 'u-role')).toEqual([both, roleOnly].sort());
        const all = await listCentralForUser('u-both', envOf(c, schema, MAX).env);
        expect(all.map((x) => x.id).sort()).toEqual([both, unitOnly, roleOnly].sort());
        expect(all).toHaveLength(3);
      }));

    it('an org-wide template (no owner) delivers its unit targets without the owner walk; owned ones still re-check the owner subtree', () =>
      withFreshSchema(async (c, schema) => {
        const t = await tree(c);
        const wideUnits = await template(c, null, 'Org-bred', [{ unit: t.b1 }, { unit: t.a1 }]);
        // Owned by A but targeting B1 (outside A's subtree: drifted data): still blocked.
        const drifted = await template(c, t.a, 'Skred', [{ unit: t.b1 }]);
        await person(c, 'u-b1', { units: [t.b1] });
        expect(await idsFor(c, schema, 'u-b1', null)).toEqual([wideUnits]);
        expect(await idsFor(c, schema, 'u-b1', null)).not.toContain(drifted);
      }));

    it('the plan holds with ONE statement per call, and a user without role rows is not slowed by them', () =>
      withFreshSchema(async (c, schema) => {
        await wide(c);
        await person(c, 'u-no');
        const { env, calls } = envOf(c, schema, MAX);
        await listCentralForUser('u-no', env);
        await resolveCentralTemplate('u-no', '00000000-0000-4000-8000-000000000000', env);
        expect(calls).toHaveLength(2);
      }));
  });
});

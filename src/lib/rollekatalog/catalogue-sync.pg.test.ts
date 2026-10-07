// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// The real catalogue refresh (mock Rollekatalog over HTTP, real SQL, real advisory lock and
// transaction) in a throwaway schema: the upsert, deactivation instead of deletion, the
// references that must survive (people's role rows, templates' targets), the guards.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { addUser, hasPg, withFreshSchema } from '@/test/pg';
import type { ClientLike, SqlResult } from '@/lib/authz/pg-runner';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));

import { createRollekatalogClient } from './client';
import { runCatalogueRefresh } from './catalogue-sync';
import { startMockRollekatalog, type MockRollekatalog } from './mock-server';
import type { SyncEnv } from './sync-run';

let mock: MockRollekatalog;
const opened: Client[] = [];

beforeAll(async () => {
  if (hasPg) mock = await startMockRollekatalog();
});
afterAll(async () => {
  if (mock) await mock.close();
});
beforeEach(() => {
  if (!hasPg) return;
  mock.resetData();
  mock.setFaults([]);
  mock.clearRequests();
  vi.stubEnv('ROLLEKATALOG_URL', mock.url);
  vi.stubEnv('ROLLEKATALOG_READ_API_KEY', mock.readKey);
  vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', '');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.allSettled(opened.splice(0).map((c) => c.end()));
});

function schemaEnv(schema: string): SyncEnv {
  return {
    schema,
    connect: async (): Promise<ClientLike> => {
      const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await c.connect();
      opened.push(c);
      return {
        query: (text, params) => c.query(text, params as unknown[] | undefined) as unknown as Promise<SqlResult<never>>,
        release: () => void c.end().catch(() => {}),
      };
    },
  };
}

const client = () => createRollekatalogClient({ backoffMs: 1, sleep: async () => {} });
const refresh = (schema: string, opts: { force?: boolean } = {}) =>
  runCatalogueRefresh({ trigger: 'cron', ...opts }, { env: schemaEnv(schema), client: client() });
const catalogueRows = async (c: Client) =>
  (await c.query(`SELECT kind, identifier, name, source, active FROM external_roles ORDER BY kind, identifier`)).rows;

describe.skipIf(!hasPg)('role catalogue refresh (real Postgres)', () => {
  it('first refresh fills the catalogue from user roles and role groups', () =>
    withFreshSchema(async (c, schema) => {
      const r = await refresh(schema);
      expect(r).toEqual({ status: 'success', counts: { fetched: 6, added: 6, updated: 0, deactivated: 0, skipped: 0 }, errorCode: null });
      expect(await catalogueRows(c)).toEqual([
        { kind: 'group', identifier: '11', name: 'Rollebuket: Socialforvaltningen', source: 'rollekatalog', active: true },
        { kind: 'group', identifier: '12', name: 'Rollebuket: Skole og dagtilbud', source: 'rollekatalog', active: true },
        { kind: 'role', identifier: '104', name: 'Rolle uden identifikator', source: 'rollekatalog', active: true },
        { kind: 'role', identifier: 'leder', name: 'Leder', source: 'rollekatalog', active: true },
        { kind: 'role', identifier: 'sagsbehandler', name: 'Sagsbehandler', source: 'rollekatalog', active: true },
        { kind: 'role', identifier: 'tt-skabelonansvarlig', name: 'Skabelonansvarlig', source: 'rollekatalog', active: true },
      ]);
      // GET only, READ key only; the ORG key was never needed.
      expect(mock.requests.every((q) => q.method === 'GET' && q.keyRole === 'read')).toBe(true);
    }));

  it('is idempotent and refreshes names; a second run adds nothing', () =>
    withFreshSchema(async (c, schema) => {
      await refresh(schema);
      mock.setData({ roleGroups: [{ id: 11, name: 'Omdøbt buket' }, { id: 12, name: 'Rollebuket: Skole og dagtilbud' }] });
      const r = await refresh(schema);
      expect(r.counts).toMatchObject({ added: 0, updated: 6, deactivated: 0 });
      expect((await catalogueRows(c)).find((x) => x.identifier === '11')!.name).toBe('Omdøbt buket');
    }));

  it('an entry that left Rollekatalog is DEACTIVATED, never deleted, and a returning one is reactivated', () =>
    withFreshSchema(async (c, schema) => {
      await refresh(schema);
      mock.setData({ userRoles: (mock.getData().userRoles as Array<{ identifier: string | null }>).filter((r) => r.identifier !== 'leder') });
      const r = await refresh(schema);
      expect(r.counts).toMatchObject({ fetched: 5, deactivated: 1 });
      expect((await catalogueRows(c)).find((x) => x.identifier === 'leder')).toMatchObject({ active: false });
      expect(await catalogueRows(c)).toHaveLength(6);

      mock.resetData();
      await refresh(schema);
      expect((await catalogueRows(c)).find((x) => x.identifier === 'leder')).toMatchObject({ active: true });
    }));

  it('keeps what references a withdrawn entry: the people holding it and the templates targeting it', () =>
    withFreshSchema(async (c, schema) => {
      await refresh(schema);
      await addUser(c, 'u1');
      await c.query(`INSERT INTO user_external_roles (user_id, kind, identifier) VALUES ('u1', 'role', 'leder')`);
      const tpl = await c.query(`INSERT INTO central_templates (name, prompt) VALUES ('Org-bred', 'P') RETURNING id`);
      await c.query(`INSERT INTO central_template_principal_targets (template_id, kind, identifier) VALUES ($1, 'role', 'leder')`, [tpl.rows[0].id]);

      mock.setData({ userRoles: (mock.getData().userRoles as Array<{ identifier: string | null }>).filter((r) => r.identifier !== 'leder') });
      expect((await refresh(schema)).status).toBe('success');

      expect((await c.query('SELECT count(*)::int AS n FROM user_external_roles')).rows[0].n).toBe(1);
      expect((await c.query('SELECT count(*)::int AS n FROM central_template_principal_targets')).rows[0].n).toBe(1);
      expect((await catalogueRows(c)).find((x) => x.identifier === 'leder')).toMatchObject({ active: false });
    }));

  it("never touches another source's rows: a key that exists as a config row is left out of the refresh (config wins) and a config-only entry stays active", () =>
    withFreshSchema(async (c, schema) => {
      await c.query(`INSERT INTO external_roles (kind, identifier, name, source) VALUES ('role', 'leder', 'Min leder', 'config'), ('group', 'kun-config', 'Kun config', 'config')`);
      const r = await refresh(schema);
      expect(r.status).toBe('success');
      const rows = await catalogueRows(c);
      expect(rows.find((x) => x.identifier === 'leder')).toMatchObject({ name: 'Min leder', source: 'config', active: true });
      expect(rows.find((x) => x.identifier === 'kun-config')).toMatchObject({ source: 'config', active: true });
      expect(rows).toHaveLength(7);
    }));

  it('an empty answer aborts and leaves the catalogue exactly as it was', () =>
    withFreshSchema(async (c, schema) => {
      await refresh(schema);
      const before = await catalogueRows(c);
      mock.setData({ userRoles: [], roleGroups: [] });
      const r = await refresh(schema, { force: true });
      expect(r).toMatchObject({ status: 'aborted', errorCode: 'empty_response' });
      expect(await catalogueRows(c)).toEqual(before);
    }));

  it('an empty list of ONE kind aborts while active entries of that kind exist, even when forced; a kind switched off with none is left alone', () =>
    withFreshSchema(async (c, schema) => {
      await refresh(schema);
      const before = await catalogueRows(c);
      mock.setData({ roleGroups: [] });
      for (const force of [false, true]) {
        expect(await refresh(schema, { force })).toMatchObject({ status: 'aborted', errorCode: 'empty_response' });
      }
      expect(await catalogueRows(c)).toEqual(before);

      // With the group list switched off, only roles are read and the groups stay active.
      vi.stubEnv('ROLLEKATALOG_ROLEGROUPS_PATH', 'none');
      const r = await refresh(schema);
      expect(r).toMatchObject({ status: 'success', counts: { fetched: 4, deactivated: 0 } });
      expect((await catalogueRows(c)).filter((x) => x.kind === 'group').every((x) => x.active)).toBe(true);
    }));

  it('too many removals abort unless forced; the forced run deactivates them', () =>
    withFreshSchema(async (c, schema) => {
      const many = Array.from({ length: 20 }, (_, i) => ({ id: 1000 + i, identifier: `r${i}`, name: `Rolle ${i}`, description: '', itSystemName: 'S' }));
      mock.setData({ userRoles: many, roleGroups: [{ id: 1, name: 'Buket' }] });
      expect((await refresh(schema)).counts.added).toBe(21);

      mock.setData({ userRoles: many.slice(0, 10) });
      const r = await refresh(schema);
      expect(r).toMatchObject({ status: 'aborted', errorCode: 'removal_threshold' });
      expect((await c.query('SELECT count(*)::int AS n FROM external_roles WHERE active')).rows[0].n).toBe(21);

      const forced = await refresh(schema, { force: true });
      expect(forced).toMatchObject({ status: 'success', counts: { deactivated: 10 } });
      expect((await c.query('SELECT count(*)::int AS n FROM external_roles WHERE active')).rows[0].n).toBe(11);
    }));

  it('a failed fetch (wrong key, server error, bad JSON) changes nothing and reports the short code', () =>
    withFreshSchema(async (c, schema) => {
      await refresh(schema);
      const before = await catalogueRows(c);
      mock.setFaults([{ match: '/api/read/rolegroups', status: 500, times: 10 }]);
      expect(await refresh(schema)).toMatchObject({ status: 'error', errorCode: 'server_error' });
      mock.setFaults([{ match: '/api/read/userroles', invalidJson: true }]);
      expect(await refresh(schema)).toMatchObject({ status: 'error', errorCode: 'invalid_response' });
      vi.stubEnv('ROLLEKATALOG_READ_API_KEY', 'wrong');
      mock.setFaults([]);
      expect(await refresh(schema)).toMatchObject({ status: 'error', errorCode: 'unauthorized' });
      expect(await catalogueRows(c)).toEqual(before);
    }));

  it('two overlapping runs: one wins, the other answers already_running; the lock is free afterwards', () =>
    withFreshSchema(async (c, schema) => {
      mock.setFaults([{ match: '/api/read/userroles', delayMs: 300, times: 1 }]);
      const [a, b] = await Promise.all([refresh(schema), (async () => { await new Promise((r) => setTimeout(r, 50)); return refresh(schema); })()]);
      expect([a.status, b.status].sort()).toEqual(['already_running', 'success']);
      expect((await refresh(schema)).status).toBe('success');
      expect(await catalogueRows(c)).toHaveLength(6);
    }));

  it('errors and counts never contain a key, a URL or a role name', () =>
    withFreshSchema(async (_c, schema) => {
      vi.stubEnv('ROLLEKATALOG_READ_API_KEY', 'wrong-key-value');
      const r = await refresh(schema);
      expect(JSON.stringify(r)).not.toMatch(/wrong-key-value|127\.0\.0\.1|Sagsbehandler/);
      expect(JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toMatch(/wrong-key-value|127\.0\.0\.1/);
    }));
});

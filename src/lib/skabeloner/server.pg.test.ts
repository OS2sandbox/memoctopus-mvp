// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// The personal template changelog against a real per-user schema (u_<id>): concurrent edits must
// number their versions without a unique-key collision or a lost entry, and a note alone, the lazy
// version 1, the absence of any pruning and a legacy NOT NULL snapshot column must behave.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { hasPg } from '@/test/pg';

const holder = vi.hoisted(() => ({ pool: undefined as unknown as import('pg').Pool }));
vi.mock('@/lib/db', async () => {
  const { Pool: P } = await import('pg');
  holder.pool = new P({ connectionString: process.env.TEST_DATABASE_URL, max: 12 });
  return { pool: holder.pool, db: {} };
});

import { createSkabelon, updateSkabelonWithHistory } from './server';

const users: string[] = [];
const newUser = () => {
  const id = randomUUID();
  users.push(id);
  return id;
};
const schemaOf = (id: string) => `u_${id.replace(/-/g, '_')}`;

afterAll(async () => {
  if (!hasPg) return;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  for (const u of users) await admin.query(`DROP SCHEMA IF EXISTS "${schemaOf(u)}" CASCADE`);
  await admin.end();
  await holder.pool.end();
});

const versionsOf = async (u: string, id: string) =>
  (await holder.pool.query(`SELECT version, change_note, changed_fields FROM "${schemaOf(u)}".skabelon_versions WHERE skabelon_id = $1 ORDER BY version`, [id])).rows;

describe.skipIf(!hasPg)('personal template changelog (real Postgres, per-user schema)', () => {
  it('creating writes the row and version 1 together', async () => {
    const u = newUser();
    const t = await createSkabelon(u, { name: 'Min', prompt: 'P' });
    expect(await versionsOf(u, t.id)).toEqual([{ version: 1, change_note: null, changed_fields: [] }]);
  });

  it('concurrent PUTs on one template: every edit lands, versions are 1..N without gaps or collisions', async () => {
    const u = newUser();
    const t = await createSkabelon(u, { name: 'Min', prompt: 'P0' });
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => updateSkabelonWithHistory(u, t.id, { name: 'Min', prompt: `P${i + 1}` }, `Rettelse ${i + 1}`)),
    );
    expect(results.every((r) => r !== null)).toBe(true);
    const rows = await versionsOf(u, t.id);
    expect(rows.map((r) => r.version)).toEqual(Array.from({ length: N + 1 }, (_, i) => i + 1));
    expect(new Set(rows.slice(1).map((r) => r.change_note)).size).toBe(N);
    // Serialised by the row lock: each edit saw the previous one's result, so every one changed `prompt`.
    expect(rows.slice(1).every((r) => r.changed_fields.includes('prompt'))).toBe(true);
  });

  it('a note typed with no field change is kept as its own version', async () => {
    const u = newUser();
    const t = await createSkabelon(u, { name: 'Min', prompt: 'P' });
    const r = await updateSkabelonWithHistory(u, t.id, { name: 'Min', prompt: 'P' }, 'Bare en note');
    expect(r?.changedFields).toEqual([]);
    expect(await versionsOf(u, t.id)).toEqual([
      { version: 1, change_note: null, changed_fields: [] },
      { version: 2, change_note: 'Bare en note', changed_fields: [] },
    ]);
    // No change and no note: nothing is written.
    await updateSkabelonWithHistory(u, t.id, { name: 'Min', prompt: 'P' }, null);
    expect(await versionsOf(u, t.id)).toHaveLength(2);
  });

  it('a template that predates the changelog gets its version 1 lazily on the first edit', async () => {
    const u = newUser();
    const t = await createSkabelon(u, { name: 'Gammel', prompt: 'Før' });
    await holder.pool.query(`DELETE FROM "${schemaOf(u)}".skabelon_versions WHERE skabelon_id = $1`, [t.id]);
    await updateSkabelonWithHistory(u, t.id, { name: 'Gammel', prompt: 'Efter' }, null);
    const rows = await versionsOf(u, t.id);
    expect(rows.map((r) => [r.version, r.changed_fields])).toEqual([[1, []], [2, ['prompt']]]);
  });

  it('never prunes: a long history keeps every version (audit events reference them)', async () => {
    const u = newUser();
    const t = await createSkabelon(u, { name: 'Min', prompt: 'P0' });
    await holder.pool.query(
      `INSERT INTO "${schemaOf(u)}".skabelon_versions (skabelon_id, version, change_note, changed_fields)
       SELECT $1, g, 'n' || g, '{}' FROM generate_series(2, 120) g`,
      [t.id],
    );
    await updateSkabelonWithHistory(u, t.id, { name: 'Min', prompt: 'Ny' }, null);
    const rows = await versionsOf(u, t.id);
    expect(rows).toHaveLength(121);
    expect(rows[0].version).toBe(1);
    expect(rows.at(-1)!.version).toBe(121);
  });

  it('a schema from before has a NOT NULL snapshot column: ensureUserSchema relaxes it, keeps its data, and edits still work', async () => {
    const u = newUser();
    const t = await createSkabelon(u, { name: 'Min', prompt: 'P0' });
    const sch = schemaOf(u);
    await holder.pool.query(`ALTER TABLE "${sch}".skabelon_versions ADD COLUMN snapshot JSONB NOT NULL DEFAULT '{}'`);
    await holder.pool.query(`UPDATE "${sch}".skabelon_versions SET snapshot = '{"prompt":"P0"}'`);
    (globalThis as unknown as { initializedSchemas: Set<string> }).initializedSchemas.delete(u);
    await updateSkabelonWithHistory(u, t.id, { name: 'Min', prompt: 'P1' }, 'efter');
    const nullable = (await holder.pool.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'skabelon_versions' AND column_name = 'snapshot'`,
      [sch],
    )).rows[0].is_nullable;
    expect(nullable).toBe('YES');
    const snaps = (await holder.pool.query(`SELECT snapshot FROM "${sch}".skabelon_versions ORDER BY version`)).rows.map((r) => r.snapshot);
    expect(snaps[0]).toEqual({ prompt: 'P0' });
    expect((await versionsOf(u, t.id)).map((r) => r.version)).toEqual([1, 2]);
  });

  it('a missing template answers null and creates nothing', async () => {
    const u = newUser();
    await createSkabelon(u, { name: 'x', prompt: 'p' });
    expect(await updateSkabelonWithHistory(u, 'findes-ikke', { name: 'y' }, 'note')).toBeNull();
  });
});

// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// The personal template changelog against a real per-user schema (u_<id>): concurrent edits must
// number their versions without a unique-key collision or a lost entry, and a note alone, the lazy
// version 1 and the cap must behave.
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

import { SKABELON_VERSION_CAP, createSkabelon, listSkabelonVersions, updateSkabelonWithHistory } from './server';

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
    const snap = (await holder.pool.query(`SELECT snapshot FROM "${schemaOf(u)}".skabelon_versions WHERE skabelon_id = $1 AND version = 1`, [t.id])).rows[0].snapshot;
    expect(snap.prompt).toBe('Før');
  });

  it('keeps only the newest versions (the cap) and prunes the oldest', async () => {
    const u = newUser();
    const t = await createSkabelon(u, { name: 'Min', prompt: 'P0' });
    // Seed a long history directly, then edit once.
    await holder.pool.query(
      `INSERT INTO "${schemaOf(u)}".skabelon_versions (skabelon_id, version, change_note, changed_fields, snapshot)
       SELECT $1, g, NULL, '{}', '{}' FROM generate_series(2, $2::int) g`,
      [t.id, SKABELON_VERSION_CAP + 20],
    );
    await updateSkabelonWithHistory(u, t.id, { name: 'Min', prompt: 'Ny' }, null);
    const rows = await versionsOf(u, t.id);
    expect(rows).toHaveLength(SKABELON_VERSION_CAP);
    expect(rows.at(-1)!.version).toBe(SKABELON_VERSION_CAP + 21);
    expect(rows[0].version).toBe(SKABELON_VERSION_CAP + 21 - SKABELON_VERSION_CAP + 1);
    expect((await listSkabelonVersions(u, t.id))!.length).toBe(SKABELON_VERSION_CAP);
  });

  it('a missing template answers null and creates nothing', async () => {
    const u = newUser();
    await createSkabelon(u, { name: 'x', prompt: 'p' });
    expect(await updateSkabelonWithHistory(u, 'findes-ikke', { name: 'y' }, 'note')).toBeNull();
  });
});

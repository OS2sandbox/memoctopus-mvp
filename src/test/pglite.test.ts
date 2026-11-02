import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', async () => (await import('@/test/pglite')).pgliteDbModule());

import { ensureUserSchema, queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';
import { pgliteSql, resetPgliteDb, usePgliteDb } from './pglite';

usePgliteDb();

describe('the PGlite test database', () => {
  it('runs ensureUserSchema for real, twice (it has to be idempotent)', async () => {
    await ensureUserSchema('user-1');
    await ensureUserSchema('user-1');
    const tables = await pgliteSql<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'u_user_1' ORDER BY 1`,
    );
    expect(tables.map((t) => t.table_name)).toEqual(expect.arrayContaining(['meetings', 'teams_meetings']));
  });

  it("keeps each user's queries in that user's own schema", async () => {
    await queryUserSchema('user-1', `INSERT INTO templates (name) VALUES ('kun bruger 1')`);
    const [mine, theirs] = await Promise.all([
      queryUserSchema<{ name: string }>('user-1', `SELECT name FROM templates WHERE name = 'kun bruger 1'`),
      queryUserSchema<{ name: string }>('user-2', `SELECT name FROM templates WHERE name = 'kun bruger 1'`),
    ]);
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it('returns values the way node-postgres does', async () => {
    const row = await queryUserSchemaOne<{ big: unknown; at: unknown; doc: unknown }>(
      'user-1',
      `SELECT $1::bigint AS big, $2::timestamptz AS at, '{"a":1}'::jsonb AS doc`,
      [12345, new Date('2026-09-08T10:00:00Z')],
    );
    expect(row).toEqual({ big: '12345', at: new Date('2026-09-08T10:00:00Z'), doc: { a: 1 } });
  });

  it('starts from a clean slate after a reset', async () => {
    await queryUserSchema('user-1', `INSERT INTO templates (name) VALUES ('x')`);
    await resetPgliteDb();
    const rows = await queryUserSchema('user-1', `SELECT 1 FROM templates WHERE name = 'x'`);
    expect(rows).toHaveLength(0);
  });
});

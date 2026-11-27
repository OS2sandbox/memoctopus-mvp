// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// 0006 renames the stored role keys of existing local grants (so existing administrators, and the
// last-administrator guard, survive the move to three roles) and drops the removed log-reader role.
// withFreshSchema has already applied it to an empty table, so the test seeds legacy rows and runs
// the statements again, which is exactly what an upgrade of a populated database does.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasPg, withFreshSchema } from '@/test/pg';

const sql6 = readFileSync(path.resolve(__dirname, '../../../drizzle/0006_three_roles.sql'), 'utf8');

describe.skipIf(!hasPg)('migration 0006_three_roles (real Postgres)', () => {
  it('renames the legacy role keys, drops tt-logleser rows and is idempotent', () =>
    withFreshSchema(async (c, schema) => {
      const keys = ['tt-administrator', 'tt-skabelonansvarlig', 'tt-bruger', 'tt-logleser'];
      for (const key of keys) {
        const u = await c.query(`INSERT INTO directory_users (name, source) VALUES ('Test', 'local') RETURNING uuid`);
        await c.query(
          `INSERT INTO role_assignments (directory_user_uuid, role_key, source) VALUES ($1, $2, 'local')`,
          [u.rows[0].uuid, key],
        );
      }
      const snapshot = async () =>
        (await c.query('SELECT directory_user_uuid, role_key FROM role_assignments ORDER BY role_key, directory_user_uuid')).rows;
      const run = async () => {
        for (const stmt of sql6.replaceAll('"public".', `"${schema}".`).split('--> statement-breakpoint')) {
          if (stmt.trim()) await c.query(stmt);
        }
      };

      await run();
      const after = await snapshot();
      expect(after.map((r) => r.role_key)).toEqual(['admin', 'bruger', 'bygger']);

      await run();
      expect(await snapshot()).toEqual(after);
    }));
});

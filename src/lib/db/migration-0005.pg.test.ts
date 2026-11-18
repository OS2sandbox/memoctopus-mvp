// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// 0005 holds what was first folded into 0004 and so already exists on scratch and dev databases:
// it must apply on a fresh database AND on one that already has those objects.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasPg, withFreshSchema } from '@/test/pg';

const sql5 = readFileSync(path.resolve(__dirname, '../../../drizzle/0005_shared_prompt_targets.sql'), 'utf8');

describe.skipIf(!hasPg)('migration 0005_shared_prompt_targets (real Postgres)', () => {
  it('can be applied again on a database that already has its objects (a 0004 that carried them)', () =>
    withFreshSchema(async (c, schema) => {
      // withFreshSchema applies every migration, and 0007 drops the owner column that one 0005 statement
      // makes nullable; that statement cannot run after 0007, so the re-run leaves it out.
      const statements = sql5.replaceAll('"public".', `"${schema}".`).split('--> statement-breakpoint');
      const rerun = statements.filter((stmt) => stmt.trim() && !stmt.includes('owner_org_unit_uuid'));
      expect(rerun).toHaveLength(statements.filter((stmt) => stmt.trim()).length - 1);
      for (const stmt of rerun) await c.query(stmt);
      const checks = await c.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'central_template_versions'::regclass AND contype = 'c' AND conname LIKE '%principal_targets%'`,
      );
      expect(checks.rows).toHaveLength(1);
    }));

  it('principal_targets of a version row must be a JSON array', () =>
    withFreshSchema(async (c) => {
      const t = await c.query(`INSERT INTO central_templates (name, prompt) VALUES ('T', 'P') RETURNING id`);
      const insert = (value: string) =>
        c.query(
          `INSERT INTO central_template_versions (template_id, version, change_type, change_note, content, targets, principal_targets)
           VALUES ($1, $2, 'create', 'En tilstrækkelig note', '{}'::jsonb, '[]'::jsonb, $3::jsonb)`,
          [t.rows[0].id, value === '[]' ? 1 : value === '{"a":1}' ? 2 : 3, value],
        );
      await insert('[]');
      await expect(insert('{"a":1}')).rejects.toMatchObject({ code: '23514' });
      await expect(insert('"text"')).rejects.toMatchObject({ code: '23514' });
    }));

  it('existing version rows get an empty array; the column defaults to []', () =>
    withFreshSchema(async (c) => {
      const t = await c.query(`INSERT INTO central_templates (name, prompt) VALUES ('T', 'P') RETURNING id`);
      await c.query(
        `INSERT INTO central_template_versions (template_id, version, change_type, change_note, content, targets)
         VALUES ($1, 1, 'create', 'En tilstrækkelig note', '{}'::jsonb, '[]'::jsonb)`,
        [t.rows[0].id],
      );
      expect((await c.query('SELECT principal_targets FROM central_template_versions')).rows[0].principal_targets).toEqual([]);
    }));
});

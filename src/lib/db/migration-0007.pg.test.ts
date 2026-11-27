// Needs a real Postgres 15+; skipped unless TEST_DATABASE_URL is set (see src/test/pg.ts).
// 0007 moves the ownership of a central template from an org unit to the person who created it.
// withFreshSchema has already applied it, so the owner column is gone; the backfill is checked by
// seeding a template without a creator and running the statements again, which is also the
// idempotency check.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasPg, withFreshSchema } from '@/test/pg';

const sql7 = readFileSync(path.resolve(__dirname, '../../../drizzle/0007_template_creator.sql'), 'utf8');

describe.skipIf(!hasPg)('migration 0007_template_creator (real Postgres)', () => {
  it('leaves created_by_user_id (indexed) and no owner_org_unit_uuid', () =>
    withFreshSchema(async (c, schema) => {
      const cols = await c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'central_templates' AND column_name IN ('created_by_user_id', 'owner_org_unit_uuid')`,
        [schema],
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual(['created_by_user_id']);
      const idx = await c.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'central_templates'`, [schema]);
      expect(idx.rows.map((r) => r.indexname)).toContain('central_templates_created_by_idx');
      expect(idx.rows.map((r) => r.indexname)).not.toContain('central_templates_owner_idx');
    }));

  it('fills a missing creator from version 1, keeps a set one, and can run again', () =>
    withFreshSchema(async (c, schema) => {
      const tpl = async (creator: string | null) =>
        (await c.query(`INSERT INTO central_templates (created_by_user_id, name, prompt) VALUES ($1, 'T', 'P') RETURNING id`, [creator])).rows[0]
          .id as string;
      const version = (id: string, n: number, by: string | null) =>
        c.query(
          `INSERT INTO central_template_versions (template_id, version, change_type, change_note, changed_by_user_id, content, targets)
           VALUES ($1, $2, $3, 'En tilstrækkelig note', $4, '{}'::jsonb, '[]'::jsonb)`,
          [id, n, n === 1 ? 'create' : 'update', by],
        );
      const missing = await tpl(null);
      await version(missing, 1, 'creator');
      await version(missing, 2, 'editor'); // a later editor is not the creator
      const kept = await tpl('keep');
      await version(kept, 1, 'someone-else');
      const anonymous = await tpl(null);
      await version(anonymous, 1, null);

      const run = async () => {
        for (const stmt of sql7.replaceAll('"public".', `"${schema}".`).split('--> statement-breakpoint')) {
          if (stmt.trim()) await c.query(stmt);
        }
      };
      const creators = async () =>
        Object.fromEntries(
          (await c.query('SELECT id, created_by_user_id FROM central_templates')).rows.map((r) => [r.id, r.created_by_user_id]),
        );

      await run();
      const after = await creators();
      expect(after).toEqual({ [missing]: 'creator', [kept]: 'keep', [anonymous]: null });
      await run();
      expect(await creators()).toEqual(after);
    }));

  it('deletes the unit-scoped Rollekatalog rows and keeps local and unscoped ones', () =>
    withFreshSchema(async (c, schema) => {
      const unit = (await c.query(`INSERT INTO org_units (name, source) VALUES ('Enhed', 'local') RETURNING uuid`)).rows[0].uuid;
      const person = (await c.query(`INSERT INTO directory_users (name, source) VALUES ('Test', 'local') RETURNING uuid`)).rows[0].uuid;
      const grant = (source: string, scope: string | null) =>
        c.query(
          `INSERT INTO role_assignments (directory_user_uuid, role_key, scope_org_unit_uuid, source, synced_at)
           VALUES ($1, 'bygger', $2, $3, now())`,
          [person, scope, source],
        );
      await grant('rollekatalog', unit);
      await grant('rollekatalog', null);
      await grant('local', unit);

      const run = async () => {
        for (const stmt of sql7.replaceAll('"public".', `"${schema}".`).split('--> statement-breakpoint')) {
          if (stmt.trim()) await c.query(stmt);
        }
      };
      const rows = async () =>
        (await c.query('SELECT source, scope_org_unit_uuid IS NULL AS unscoped FROM role_assignments ORDER BY source, 2')).rows;

      await run();
      expect(await rows()).toEqual([
        { source: 'local', unscoped: false },
        { source: 'rollekatalog', unscoped: true },
      ]);
      await run();
      expect(await rows()).toHaveLength(2);
    }));
});

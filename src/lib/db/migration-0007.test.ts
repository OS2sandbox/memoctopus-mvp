// Static checks of migration 0007 (no database needed); migration-0007.pg.test.ts runs it for real.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DRIZZLE = path.resolve(__dirname, '../../../drizzle');
const journal = JSON.parse(readFileSync(path.join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};
const sql = readFileSync(path.join(DRIZZLE, '0007_template_creator.sql'), 'utf8');
const statements = sql
  .split('--> statement-breakpoint')
  .map((s) => s.replace(/^--.*$/gm, '').trim())
  .filter(Boolean);

describe('migration 0007_template_creator', () => {
  it('is journaled right after 0006', () => {
    expect(journal.entries.map((e) => e.tag).slice(6, 8)).toEqual(['0006_three_roles', '0007_template_creator']);
    expect(journal.entries[7].idx).toBe(7);
  });

  it('adds the creator, fills it from version 1, drops the owner unit and the scoped Rollekatalog rows, all idempotently', () => {
    expect(statements).toHaveLength(6);
    expect(statements[0]).toBe('ALTER TABLE "central_templates" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;');
    // The backfill runs before the drop and only fills rows that have no creator yet.
    expect(statements[1]).toMatch(/^UPDATE "central_templates" ct SET "created_by_user_id" = v\."changed_by_user_id"/);
    expect(statements[1]).toMatch(/v\."version" = 1 AND ct\."created_by_user_id" IS NULL;$/);
    expect(statements[2]).toContain('CREATE INDEX IF NOT EXISTS "central_templates_created_by_idx"');
    expect(statements[3]).toBe('DROP INDEX IF EXISTS "central_templates_owner_idx";');
    expect(statements[4]).toBe('ALTER TABLE "central_templates" DROP COLUMN IF EXISTS "owner_org_unit_uuid";');
    expect(statements[5]).toBe(
      `DELETE FROM "role_assignments" WHERE "source" = 'rollekatalog' AND "scope_org_unit_uuid" IS NOT NULL;`,
    );
  });

  it('never writes the changelog (append-only, only read)', () => {
    for (const s of statements) expect(s).not.toMatch(/^(UPDATE|DELETE|INSERT|ALTER TABLE)\s+"central_template_versions"/);
  });
});

// Static checks of migration 0005 (no database needed). What the constraints actually do is
// proven by central.pg.test.ts and migrations.pg.test.ts when a Postgres is available.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DRIZZLE = path.resolve(__dirname, '../../../drizzle');
const journal = JSON.parse(readFileSync(path.join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const sql = readFileSync(path.join(DRIZZLE, '0005_shared_prompt_targets.sql'), 'utf8');
const statements = sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);

describe('migration 0005_shared_prompt_targets', () => {
  it('is journaled right after 0004, with a later timestamp, and has a snapshot chained to 0004', () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.slice(4, 6)).toEqual(['0004_claims_roles', '0005_shared_prompt_targets']);
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_e, i) => i));
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    const s4 = JSON.parse(readFileSync(path.join(DRIZZLE, 'meta/0004_snapshot.json'), 'utf8')) as { id: string };
    const s5 = JSON.parse(readFileSync(path.join(DRIZZLE, 'meta/0005_snapshot.json'), 'utf8')) as {
      prevId: string;
      tables: Record<string, { checkConstraints: Record<string, unknown> }>;
    };
    expect(s5.prevId).toBe(s4.id);
    expect(s5.tables['public.central_template_versions'].checkConstraints).toHaveProperty(
      'central_template_versions_principal_targets_check',
    );
  });

  it('makes the owner unit optional (an organisation-wide template) and keeps the RESTRICT foreign key for owned ones', () => {
    expect(sql).toContain('ALTER TABLE "central_templates" ALTER COLUMN "owner_org_unit_uuid" DROP NOT NULL');
    expect(readFileSync(path.join(DRIZZLE, '0003_central_templates.sql'), 'utf8')).toMatch(
      /"central_templates_owner_org_unit_uuid_org_units_uuid_fk".*ON DELETE restrict/,
    );
  });

  it('creates the role/group targets: cascade from the template, RESTRICT on the catalogue (a targeted entry is never deleted)', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "central_template_principal_targets"');
    expect(sql).toContain('PRIMARY KEY("template_id","kind","identifier")');
    expect(sql).toMatch(
      /"central_template_principal_targets_template_id_central_templates_id_fk" FOREIGN KEY \("template_id"\) REFERENCES "public"\."central_templates"\("id"\) ON DELETE cascade/,
    );
    expect(sql).toMatch(
      /"central_template_principal_targets_role_fk" FOREIGN KEY \("kind","identifier"\) REFERENCES "public"\."external_roles"\("kind","identifier"\) ON DELETE restrict/,
    );
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "central_template_principal_targets_role_idx"');
    const table = /CREATE TABLE IF NOT EXISTS "central_template_principal_targets" \(([\s\S]*?)\);/.exec(sql)![1];
    expect([...table.matchAll(/^\s*"(\w+)"/gm)].map((m) => m[1])).toEqual(['template_id', 'kind', 'identifier']);
  });

  it('adds the principal snapshot to the append-only version rows as a defaulted array column (the trigger is untouched)', () => {
    expect(sql).toContain(`ADD COLUMN IF NOT EXISTS "principal_targets" jsonb DEFAULT '[]'::jsonb NOT NULL`);
    expect(sql).toContain(`CHECK (jsonb_typeof("central_template_versions"."principal_targets") = 'array')`);
    expect(sql).not.toMatch(/TRIGGER|central_template_versions_guard/);
  });

  it('is safe to re-run on a database that got these statements through the earlier 0004 (every ADD is preceded by IF NOT EXISTS or DROP IF EXISTS)', () => {
    for (const m of sql.matchAll(/ADD CONSTRAINT "(\w+)"/g)) {
      expect(sql).toContain(`DROP CONSTRAINT IF EXISTS "${m[1]}"`);
    }
  });

  it('is one statement per breakpoint (the pg driver sends each on its own)', () => {
    for (const s of statements) {
      const body = s.replace(/--[^\n]*/g, '').replace(/\$\$[\s\S]*?\$\$/g, '');
      expect(body.split(';').filter((p) => p.trim()).length, s.slice(0, 60)).toBe(1);
    }
  });
});

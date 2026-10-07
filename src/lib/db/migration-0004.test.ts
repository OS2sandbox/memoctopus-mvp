// Static checks of migration 0004 (no database needed). What the constraints actually do is
// proven by claims-roles.pg.test.ts and migrations.pg.test.ts when a Postgres is available.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DRIZZLE = path.resolve(__dirname, '../../../drizzle');
const journal = JSON.parse(readFileSync(path.join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const sql = readFileSync(path.join(DRIZZLE, '0004_claims_roles.sql'), 'utf8');
const statements = sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);

describe('migration 0004_claims_roles', () => {
  it('is journaled after 0003, in order, with a later timestamp', () => {
    expect(journal.entries.map((e) => e.tag).slice(0, 5)).toEqual([
      '0000_past_shooting_star',
      '0001_central_access',
      '0002_audit_events',
      '0003_central_templates',
      '0004_claims_roles',
    ]);
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_e, i) => i));
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
  });

  it('has a snapshot, and leaves the released-or-not 0001-0003 migrations untouched (only a new migration)', () => {
    expect(() => readFileSync(path.join(DRIZZLE, 'meta/0004_snapshot.json'), 'utf8')).not.toThrow();
    for (const tag of ['0001_central_access', '0002_audit_events', '0003_central_templates']) {
      expect(readFileSync(path.join(DRIZZLE, `${tag}.sql`), 'utf8')).not.toContain("'claims'");
    }
  });

  it("widens the three source checks to include 'claims' (drop, then re-add under the same names)", () => {
    for (const t of ['directory_users', 'org_units', 'role_assignments']) {
      expect(sql).toContain(`ALTER TABLE "${t}" DROP CONSTRAINT "${t}_source_check"`);
      expect(sql).toContain(`ALTER TABLE "${t}" ADD CONSTRAINT "${t}_source_check" CHECK ("source" in ('local', 'rollekatalog', 'claims'))`);
    }
  });

  it('creates the catalogue with its vocabularies and length limits', () => {
    expect(sql).toContain('CREATE TABLE "external_roles"');
    expect(sql).toContain(`PRIMARY KEY("kind","identifier")`);
    expect(sql).toContain(`"external_roles_kind_check" CHECK ("external_roles"."kind" in ('role', 'group'))`);
    expect(sql).toContain(`"external_roles"."source" in ('rollekatalog', 'config', 'claims')`);
    expect(sql).toContain('char_length("external_roles"."identifier") between 1 and 200');
    expect(sql).toContain('char_length("external_roles"."name") between 1 and 200');
  });

  it('keeps stored role/group values inside the catalogue by a composite foreign key, and cascades from the user', () => {
    expect(sql).toContain('CREATE TABLE "user_external_roles"');
    expect(sql).toContain(`PRIMARY KEY("user_id","kind","identifier")`);
    expect(sql).toMatch(/"user_external_roles_role_fk" FOREIGN KEY \("kind","identifier"\) REFERENCES "public"\."external_roles"\("kind","identifier"\) ON DELETE cascade/);
    expect(sql).toMatch(/"user_external_roles_user_id_users_id_fk" FOREIGN KEY \("user_id"\) REFERENCES "public"\."users"\("id"\) ON DELETE cascade/);
    expect(sql).toContain('CREATE INDEX "user_external_roles_role_idx"');
  });

  it('stores no role or group NAME of a person: the stored columns are the catalogue key and a timestamp', () => {
    const table = /CREATE TABLE "user_external_roles" \(([\s\S]*?)\);/.exec(sql)![1];
    const columns = [...table.matchAll(/^\s*"(\w+)"/gm)].map((m) => m[1]);
    expect(columns).toEqual(['user_id', 'kind', 'identifier', 'seen_at']);
  });

  it('makes the owner unit optional (an organisation-wide template) and keeps the RESTRICT foreign key for owned ones', () => {
    expect(sql).toContain('ALTER TABLE "central_templates" ALTER COLUMN "owner_org_unit_uuid" DROP NOT NULL');
    // 0003 still holds the FK with ON DELETE restrict; only the NOT NULL goes.
    expect(readFileSync(path.join(DRIZZLE, '0003_central_templates.sql'), 'utf8')).toMatch(
      /"central_templates_owner_org_unit_uuid_org_units_uuid_fk".*ON DELETE restrict/,
    );
  });

  it('creates the role/group targets: cascade from the template, RESTRICT on the catalogue (a targeted entry is never deleted)', () => {
    expect(sql).toContain('CREATE TABLE "central_template_principal_targets"');
    expect(sql).toContain('PRIMARY KEY("template_id","kind","identifier")');
    expect(sql).toMatch(
      /"central_template_principal_targets_template_id_central_templates_id_fk" FOREIGN KEY \("template_id"\) REFERENCES "public"\."central_templates"\("id"\) ON DELETE cascade/,
    );
    expect(sql).toMatch(
      /"central_template_principal_targets_role_fk" FOREIGN KEY \("kind","identifier"\) REFERENCES "public"\."external_roles"\("kind","identifier"\) ON DELETE restrict/,
    );
    expect(sql).toContain('CREATE INDEX "central_template_principal_targets_role_idx"');
    const table = /CREATE TABLE "central_template_principal_targets" \(([\s\S]*?)\);/.exec(sql)![1];
    expect([...table.matchAll(/^\s*"(\w+)"/gm)].map((m) => m[1])).toEqual(['template_id', 'kind', 'identifier']);
  });

  it('adds the principal snapshot to the append-only version rows as a defaulted column (the trigger is untouched)', () => {
    expect(sql).toContain(`ALTER TABLE "central_template_versions" ADD COLUMN "principal_targets" jsonb DEFAULT '[]'::jsonb NOT NULL`);
    expect(sql).not.toMatch(/TRIGGER|central_template_versions_guard/);
  });

  it('is one statement per breakpoint (the pg driver sends each on its own)', () => {
    for (const s of statements) {
      const body = s.replace(/--[^\n]*/g, '').replace(/\$\$[\s\S]*?\$\$/g, '');
      expect(body.split(';').filter((p) => p.trim()).length, s.slice(0, 60)).toBe(1);
    }
  });
});

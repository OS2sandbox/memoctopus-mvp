// Static checks of migration 0003 (no database needed). The behaviour of the
// constraints and the trigger is proven by central.pg.test.ts when a Postgres is available.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DRIZZLE = path.resolve(__dirname, '../../../drizzle');
const journal = JSON.parse(readFileSync(path.join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};
const sql = readFileSync(path.join(DRIZZLE, '0003_central_templates.sql'), 'utf8');
const statements = sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);

describe('migration 0003_central_templates', () => {
  it('is journaled right after 0002, in order', () => {
    expect(journal.entries.slice(0, 4).map((e) => e.tag)).toEqual([
      '0000_past_shooting_star',
      '0001_central_access',
      '0002_audit_events',
      '0003_central_templates',
    ]);
    expect(journal.entries.slice(0, 4).map((e) => e.idx)).toEqual([0, 1, 2, 3]);
    expect(() => readFileSync(path.join(DRIZZLE, 'meta/0003_snapshot.json'), 'utf8')).not.toThrow();
  });

  it('creates the three tables', () => {
    for (const t of ['central_templates', 'central_template_versions', 'central_template_targets']) {
      expect(sql).toContain(`CREATE TABLE "${t}"`);
    }
  });

  it('restricts deletion of an owning org unit but cascades targets', () => {
    expect(sql).toMatch(/"central_templates_owner_org_unit_uuid_org_units_uuid_fk".*REFERENCES "public"\."org_units"\("uuid"\) ON DELETE restrict/);
    expect(sql).toMatch(/"central_template_targets_org_unit_uuid_org_units_uuid_fk".*ON DELETE cascade/);
    expect(sql).toMatch(/"central_template_versions_template_id_central_templates_id_fk".*ON DELETE cascade/);
  });

  it('forces a change note of at least 10 meaningful characters (whitespace and invisibles stripped) on every version row', () => {
    expect(sql).toContain('char_length(regexp_replace("central_template_versions"."change_note", \'');
    expect(sql).toContain(`'g')) >= 10 and char_length("central_template_versions"."change_note") <= 2000`);
    expect(sql).not.toContain('btrim("central_template_versions"."change_note")');
    expect(sql).toContain('char_length("central_template_versions"."change_note") <= 2000');
    expect(sql).toContain('"change_note" text NOT NULL');
    expect(sql).toContain('CONSTRAINT "central_template_versions_template_version_unique" UNIQUE("template_id","version")');
  });

  it('requires at least one meaningful character in the name, with the same class as the change note', () => {
    const cls = (s: string) => /regexp_replace\([^,]+, '(\[\[:space:\][^']*\])', ''/.exec(s)?.[1];
    const note = statements.find((s) => s.includes('"central_template_versions_change_note_check"'));
    const name = statements.find((s) => s.includes('"central_templates_name_check"'));
    expect(cls(name ?? '')).toBeDefined();
    expect(cls(name ?? '')).toBe(cls(note ?? ''));
    expect(sql).toContain(`'g')) >= 1 and char_length("central_templates"."name") <= 120`);
    expect(sql).not.toContain('btrim("central_templates"."name")');
  });

  it('keeps no write-only created_by_user_id column on central_templates', () => {
    expect(sql).not.toContain('created_by_user_id');
  });

  it('declares the vocabularies and length caps', () => {
    expect(sql).toContain(`"central_templates"."status" in ('active', 'archived')`);
    expect(sql).toContain(`"change_type" in ('create', 'update', 'retarget', 'archive', 'restore')`);
    expect(sql).toContain('char_length("central_templates"."description") <= 1000');
    expect(sql).toContain('char_length("central_templates"."prompt") <= 20000');
  });

  it('hand-appends a guard that refuses UPDATE, DELETE and TRUNCATE (55000, no bypass) as separate statements', () => {
    const fn = statements.find((s) => s.includes('CREATE FUNCTION "central_template_versions_guard"'));
    expect(fn).toBeDefined();
    expect(fn).toContain("ERRCODE = '55000'");
    expect(fn).not.toContain('current_setting');
    expect(statements.some((s) => /CREATE TRIGGER "central_template_versions_no_update_delete"\s+BEFORE UPDATE OR DELETE ON "central_template_versions"\s+FOR EACH ROW/.test(s))).toBe(true);
    expect(statements.some((s) => /CREATE TRIGGER "central_template_versions_no_truncate"\s+BEFORE TRUNCATE ON "central_template_versions"\s+FOR EACH STATEMENT/.test(s))).toBe(true);
    for (const s of statements) {
      const withoutFunctionBody = s.replace(/\$\$[\s\S]*?\$\$/g, '');
      const code = withoutFunctionBody.replace(/--[^\n]*/g, '');
      // The generated FK block chains statements with ";--> statement-breakpoint", which the split above already separated.
      expect(code.split(';').filter((p) => p.trim()).length, s.slice(0, 60)).toBe(1);
    }
  });
});

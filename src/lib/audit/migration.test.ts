// Static checks of migration 0002 (no database needed). The behaviour of the
// triggers is proven by events.pg.test.ts when a Postgres is available.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DRIZZLE = path.resolve(__dirname, '../../../drizzle');
const journal = JSON.parse(readFileSync(path.join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};
const sql = readFileSync(path.join(DRIZZLE, '0002_audit_events.sql'), 'utf8');
const statements = sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);

describe('migration 0002_audit_events', () => {
  it('is journaled after 0000 and 0001, in order', () => {
    expect(journal.entries.map((e) => e.tag).slice(0, 3)).toEqual(['0000_past_shooting_star', '0001_central_access', '0002_audit_events']);
    expect(journal.entries.map((e) => e.idx).slice(0, 3)).toEqual([0, 1, 2]);
  });

  it('has a snapshot', () => {
    expect(() => readFileSync(path.join(DRIZZLE, 'meta/0002_snapshot.json'), 'utf8')).not.toThrow();
  });

  it('creates the table with no foreign keys (rows must survive user and org-unit deletion)', () => {
    expect(sql).toContain('CREATE TABLE "audit_events"');
    expect(sql).not.toMatch(/REFERENCES|FOREIGN KEY/i);
  });

  it('declares the vocabularies, the dedupe index and the lookup indexes', () => {
    expect(sql).toContain(`CHECK ("audit_events"."source" in ('server', 'client', 'system'))`);
    expect(sql).toContain(`CHECK ("audit_events"."outcome" in ('success', 'denied', 'error'))`);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "audit_events_client_event_unique".*\("actor_user_id","client_event_id"\) WHERE "audit_events"\."client_event_id" is not null/);
    for (const idx of ['occurred_at', 'actor', 'event_type', 'entity', 'org_unit']) {
      expect(sql).toContain(`"audit_events_${idx}_idx"`);
    }
  });

  it('hand-appends the guard function and both triggers as separate statements', () => {
    const fn = statements.find((s) => s.includes('CREATE FUNCTION "audit_events_guard"'));
    expect(fn).toBeDefined();
    expect(fn).toContain(`current_setting('audit.allow_prune', true) = 'on'`);
    expect(fn).toContain("TG_OP = 'DELETE'");
    expect(statements.some((s) => /CREATE TRIGGER "audit_events_no_update_delete"\s+BEFORE UPDATE OR DELETE ON "audit_events"\s+FOR EACH ROW/.test(s))).toBe(true);
    expect(statements.some((s) => /CREATE TRIGGER "audit_events_no_truncate"\s+BEFORE TRUNCATE ON "audit_events"\s+FOR EACH STATEMENT/.test(s))).toBe(true);
    // No statement may contain two statements: that would fail under the pg driver's extended protocol.
    for (const s of statements) {
      const withoutFunctionBody = s.replace(/\$\$[\s\S]*?\$\$/g, '');
      expect(withoutFunctionBody.replace(/--[^\n]*/g, '').split(';').filter((p) => p.trim()).length, s.slice(0, 60)).toBe(1);
    }
  });
});

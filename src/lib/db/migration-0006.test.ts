// Static checks of migration 0006 (no database needed); migration-0006.pg.test.ts runs it for real.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_DEFINITIONS } from '@/lib/authz/capabilities';

const DRIZZLE = path.resolve(__dirname, '../../../drizzle');
const journal = JSON.parse(readFileSync(path.join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ tag: string }>;
};
const sql = readFileSync(path.join(DRIZZLE, '0006_three_roles.sql'), 'utf8');
const statements = sql
  .split('--> statement-breakpoint')
  .map((s) => s.replace(/^--.*$/gm, '').trim())
  .filter(Boolean);

describe('migration 0006_three_roles', () => {
  it('is journaled right after 0005', () => {
    expect(journal.entries.map((e) => e.tag).slice(5, 7)).toEqual(['0005_shared_prompt_targets', '0006_three_roles']);
  });

  it('renames the three legacy keys to the current RoleKeys and deletes tt-logleser, touching only role_assignments', () => {
    expect(Object.keys(ROLE_DEFINITIONS)).toEqual(expect.arrayContaining(['admin', 'bygger', 'bruger']));
    expect(statements.map((s) => s.replace(/;$/, ''))).toEqual([
      `DELETE FROM "role_assignments" WHERE "role_key" = 'tt-logleser'`,
      `UPDATE "role_assignments" SET "role_key" = 'admin' WHERE "role_key" = 'tt-administrator'`,
      `UPDATE "role_assignments" SET "role_key" = 'bygger' WHERE "role_key" = 'tt-skabelonansvarlig'`,
      `UPDATE "role_assignments" SET "role_key" = 'bruger' WHERE "role_key" = 'tt-bruger'`,
    ]);
  });
});

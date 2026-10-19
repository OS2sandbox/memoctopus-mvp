// Static check of migration 0007 (no database needed): it drops the table of the removed
// personal-template share link, idempotently, and is journaled after 0006.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DRIZZLE = path.resolve(__dirname, '../../../drizzle');
const journal = JSON.parse(readFileSync(path.join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};

describe('migration 0007_drop_shared_skabeloner', () => {
  it('is journaled after 0006 with a later timestamp', () => {
    const e = journal.entries.find((x) => x.tag === '0007_drop_shared_skabeloner')!;
    expect(e.idx).toBe(7);
    expect(e.when).toBeGreaterThan(journal.entries[6].when);
  });

  it('drops public.shared_skabeloner only, with IF EXISTS', () => {
    const sql = readFileSync(path.join(DRIZZLE, '0007_drop_shared_skabeloner.sql'), 'utf8');
    const code = sql.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim();
    expect(code).toBe('DROP TABLE IF EXISTS "public"."shared_skabeloner";');
  });
});

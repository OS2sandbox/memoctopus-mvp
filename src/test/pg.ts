// Gated real-Postgres test lane. Mocks cannot prove constraints, FK actions or
// migrations, so tests that need them use this helper and are SKIPPED unless
// TEST_DATABASE_URL is set.
//
// Run it (PostgreSQL 15+ required: NULLS NOT DISTINCT):
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/scratch \
//     npx vitest run src/lib/db/migrations.pg.test.ts
//
// The role needs CREATE on that database. Each call creates a uniquely named
// throwaway schema, applies every drizzle migration in journal order into it,
// and always drops it again (CASCADE), so runs do not touch real data and can
// run in parallel.
//
// One deliberate rewrite: the generated SQL hard-codes the "public". qualifier
// (e.g. REFERENCES "public"."users"). Applied verbatim it would resolve to the
// real public schema instead of the throwaway one, so that qualifier is swapped
// for the throwaway schema name. Nothing else is changed.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

export const hasPg = !!process.env.TEST_DATABASE_URL;

const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle');
const BREAKPOINT = '--> statement-breakpoint';

function journalTags(): string[] {
  const journal = JSON.parse(readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag);
}

export async function withFreshSchema<T>(fn: (client: Client, schema: string) => Promise<T>): Promise<T> {
  if (!hasPg) throw new Error('withFreshSchema called without TEST_DATABASE_URL');

  const schema = `t_${randomUUID().replace(/-/g, '_')}`;
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    for (const tag of journalTags()) {
      const sql = readFileSync(path.join(DRIZZLE_DIR, `${tag}.sql`), 'utf8').replaceAll(
        '"public".',
        `"${schema}".`,
      );
      for (const stmt of sql.split(BREAKPOINT)) {
        if (stmt.trim()) await client.query(stmt);
      }
    }
    return await fn(client, schema);
  } finally {
    try {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  }
}

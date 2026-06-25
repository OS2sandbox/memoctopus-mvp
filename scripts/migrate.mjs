import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

console.log('[migrate] running migrations...');
await migrate(db, { migrationsFolder: './drizzle' });
console.log('[migrate] done');

await pool.end();

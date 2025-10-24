#!/usr/bin/env node

/**
 * Database Connection Check
 * Verifies database connection and shows table information
 */

const { Client } = require("pg");
require("dotenv").config({ path: ".env.local" });

async function checkDatabase() {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL not found in .env.local");
    process.exit(1);
  }

  const client = new Client({
    connectionString: DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("✅ Successfully connected to database\n");

    // Get database name
    const dbResult = await client.query("SELECT current_database()");
    console.log(`📊 Database: ${dbResult.rows[0].current_database}`);

    // Check if Better Auth tables exist
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('user', 'session', 'account', 'verification')
      ORDER BY table_name
    `);

    if (tables.rows.length === 0) {
      console.log("\n⚠️  No Better Auth tables found");
      console.log("Run: npm run db:generate && npm run db:migrate\n");
    } else {
      console.log("\n📋 Better Auth Tables:");
      for (const table of tables.rows) {
        const count = await client.query(
          `SELECT COUNT(*) FROM "${table.table_name}"`,
        );
        console.log(`   ✓ ${table.table_name} (${count.rows[0].count} rows)`);
      }
      console.log();
    }

    await client.end();
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
    console.log("\nTroubleshooting:");
    console.log("1. Make sure PostgreSQL is running");
    console.log("2. Run: npm run db:setup");
    console.log("3. Check your DATABASE_URL in .env.local\n");
    process.exit(1);
  }
}

checkDatabase();

#!/usr/bin/env node

/**
 * Database Setup Script
 * Creates the PostgreSQL database if it doesn't exist
 */

const { Client } = require('pg');
require('dotenv').config({ path: '.env.local' });

async function setupDatabase() {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL not found in .env.local');
    console.log('Please set DATABASE_URL in your .env.local file');
    process.exit(1);
  }

  console.log('🔧 Setting up PostgreSQL database...\n');

  // Parse the database URL to get database name and connection details
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.slice(1); // Remove leading '/'

  // Create connection to postgres database (default database)
  const postgresUrl = `${url.protocol}//${url.username}:${url.password}@${url.host}/postgres`;

  const client = new Client({
    connectionString: postgresUrl,
  });

  try {
    await client.connect();
    console.log('✅ Connected to PostgreSQL server');

    // Check if database exists
    const checkDb = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );

    if (checkDb.rows.length === 0) {
      // Create database
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`✅ Database "${dbName}" created successfully`);
    } else {
      console.log(`ℹ️  Database "${dbName}" already exists`);
    }

    await client.end();
    console.log('✅ Database setup complete!\n');
    console.log('📝 Next steps:');
    console.log('   1. Run: npm run db:generate');
    console.log('   2. Run: npm run db:migrate');
    console.log('   3. Run: npm run dev\n');

  } catch (error) {
    console.error('❌ Error setting up database:', error.message);
    console.log('\nTroubleshooting:');
    console.log('1. Make sure PostgreSQL is running');
    console.log('2. Check your DATABASE_URL in .env.local');
    console.log('3. Verify database credentials are correct\n');
    process.exit(1);
  }
}

setupDatabase();

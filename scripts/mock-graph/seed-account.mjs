#!/usr/bin/env node
// Links an existing app user to a FAKE Microsoft account so the Teams code path
// (which fetches a Graph token through better-auth) works against the mock Graph
// server without ever talking to Entra ID.
//
//   node scripts/mock-graph/seed-account.mjs <email>
//   node scripts/mock-graph/seed-account.mjs <email> --remove
//
// Needs DATABASE_URL. The app must also have MICROSOFT_CLIENT_ID/_SECRET set
// (any value) so better-auth registers the "microsoft" provider — otherwise
// getAccessToken refuses with PROVIDER_NOT_SUPPORTED before it looks at the row.
// Never run this against a real deployment: it plants a token that the mock
// accepts and real Graph rejects.

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

// Keep in sync with GRAPH_DELEGATED_SCOPES in src/lib/auth/providers.ts.
const SCOPES = [
  'openid', 'profile', 'email', 'offline_access', 'User.Read',
  'OnlineMeetings.ReadWrite', 'OnlineMeetingTranscript.Read.All',
  'OnlineMeetingRecording.Read.All',
];
const MOCK_ACCOUNT_ID = 'me-0000-0000-0000-000000000001'; // = ME.id in server.mjs

function loadDotenv() {
  if (process.env.DATABASE_URL) return;
  for (const f of ['.env.local', '.env']) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

async function main() {
  const [email, flag] = process.argv.slice(2);
  if (!email) {
    console.error('usage: node scripts/mock-graph/seed-account.mjs <email> [--remove]');
    process.exit(2);
  }
  loadDotenv();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (/@db:/.test(process.env.DATABASE_URL)) {
    console.warn('[seed] DATABASE_URL points at host "db" (docker). Override it for a local run, e.g.\n' +
      '       DATABASE_URL=postgres://postgres:postgres@localhost:5432/referat_mock node scripts/mock-graph/seed-account.mjs ' + email);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const user = (await client.query('select id, email from users where lower(email) = lower($1)', [email])).rows[0];
    if (!user) throw new Error(`no user with email ${email} — sign up in the app first`);

    if (flag === '--remove') {
      const r = await client.query("delete from accounts where user_id = $1 and provider_id = 'microsoft'", [user.id]);
      console.log(`[seed] removed ${r.rowCount} microsoft account row(s) for ${user.email}`);
      return;
    }

    const existing = (await client.query("select id from accounts where user_id = $1 and provider_id = 'microsoft'", [user.id])).rows[0];
    const far = new Date('2099-01-01T00:00:00Z');
    const values = {
      accountId: MOCK_ACCOUNT_ID,
      accessToken: 'mock-graph-access-token',
      refreshToken: 'mock-graph-refresh-token',
      scope: SCOPES.join(','), // better-auth splits on ','
    };
    if (existing) {
      await client.query(
        `update accounts set account_id=$2, access_token=$3, refresh_token=$4, access_token_expires_at=$5,
           refresh_token_expires_at=$5, scope=$6, updated_at=now() where id=$1`,
        [existing.id, values.accountId, values.accessToken, values.refreshToken, far, values.scope],
      );
      console.log(`[seed] updated microsoft account for ${user.email}`);
    } else {
      await client.query(
        `insert into accounts (id, account_id, provider_id, user_id, access_token, refresh_token,
           access_token_expires_at, refresh_token_expires_at, scope, created_at, updated_at)
         values ($1,$2,'microsoft',$3,$4,$5,$6,$6,$7,now(),now())`,
        [crypto.randomUUID(), values.accountId, user.id, values.accessToken, values.refreshToken, far, values.scope],
      );
      console.log(`[seed] linked ${user.email} to mock microsoft account ${MOCK_ACCOUNT_ID}`);
    }
    console.log('[seed] the app will now call GRAPH_BASE_URL with "Bearer mock-graph-access-token"');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[seed]', err.message);
  process.exit(1);
});

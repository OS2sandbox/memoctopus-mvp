#!/usr/bin/env node
// Standalone mock of the OS2rollekatalog API for local development, serving the
// SYNTHETIC fixtures in src/lib/rollekatalog/__fixtures__/. Plain JS with no
// imports from the TypeScript sources; it re-implements the same auth rules as
// src/lib/rollekatalog/mock-server.ts (the in-process mock used by the tests).
//
// Usage:
//   node scripts/mock-rollekatalog.mjs                # listens on 127.0.0.1:4010
//   MOCK_ROLLEKATALOG_PORT=4020 node scripts/mock-rollekatalog.mjs
//
// Then point the app at it (.env):
//   ACCESS_SOURCE=rollekatalog
//   ROLLEKATALOG_URL=http://127.0.0.1:4010     # plain http is allowed for loopback only
//   ROLLEKATALOG_READ_API_KEY=mock-read-key-0000
//   ROLLEKATALOG_ORG_API_KEY=mock-org-key-0000
//   INTERNAL_CRON_SECRET=dev-secret
// and trigger a sync:
//   curl -X POST -H "X-Cron-Secret: dev-secret" http://localhost:3004/api/internal/rollekatalog/sync
//
// Behaviour (verified from the 2026r4 source, see docs/central-access/phase0-findings.md):
//   - auth is the `ApiKey` header; missing or unknown key = 401
//   - READ key: /api/read/*, /api/user/{id}/rolesAsList, /api/v2/constraint; 403 elsewhere
//   - ORG key:  /api/organisation/v3, /api/v2/manager; 403 on the read endpoints
//   - organisation v3 only returns users with at least one position, and still contains
//     the fake cpr/nemloginUuid/phone fields (the app must drop them)
//   - rolesAsList: 404 with an empty body for unknown user/system; disabled users get 200
//     with disabled:true and their roles
// To change the data, edit the fixtures; the files are re-read on every request.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'rollekatalog', '__fixtures__');
const load = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));

const READ_KEY = process.env.ROLLEKATALOG_READ_API_KEY || 'mock-read-key-0000';
const ORG_KEY = process.env.ROLLEKATALOG_ORG_API_KEY || 'mock-org-key-0000';
const SYSTEM = process.env.ROLLEKATALOG_ITSYSTEM_ID || 'os2taletiltekst';
const PORT = Number(process.env.MOCK_ROLLEKATALOG_PORT || 4010);

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    return res.end();
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function rolesAsList(param) {
  const needle = param.toLowerCase();
  const org = load('organisation-v3.json');
  const user = org.users.find((u) => u.userId.toLowerCase() === needle || (u.extUuid || '').toLowerCase() === needle);
  if (!user) return null;
  const mine = load('role-assignments-with-constraints.json').filter(
    (a) => (a.userId || '').toLowerCase() === user.userId.toLowerCase() || a.extUuid === user.extUuid,
  );
  const ids = [...new Set(mine.flatMap((a) => a.assignments.map((x) => x.roleIdentifier)))];
  return {
    nameID: `C=DK,O=00000000,CN=${user.name},Serial=${user.extUuid}`,
    userRoles: ids.map((i) => `${i}-rolle`),
    systemRoles: ids,
    dataRoles: [],
    functionRoles: [],
    roleMap: Object.fromEntries(ids.map((i) => [`${i}-rolle`, `${i} (Mock)`])),
    disabled: user.disabled === true,
  };
}

http
  .createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://mock.invalid');
      const p = url.pathname;
      const key = req.headers['apikey'];
      if (!key) return send(res, 401);
      const role = key === READ_KEY ? 'read' : key === ORG_KEY ? 'org' : null;
      if (!role) return send(res, 401);
      if (req.method !== 'GET') return send(res, 405);

      const orgEndpoint = p === '/api/organisation/v3' || p === '/api/v2/manager';
      const readEndpoint = p.startsWith('/api/read/') || /^\/api\/user\/[^/]+\/rolesAsList$/.test(p) || p === '/api/v2/constraint';
      if (!orgEndpoint && !readEndpoint) return send(res, 404);
      if ((orgEndpoint && role !== 'org') || (readEndpoint && role !== 'read')) return send(res, 403);

      if (p === '/api/organisation/v3') {
        const org = load('organisation-v3.json');
        return send(res, 200, { ...org, users: org.users.filter((u) => u.positions && u.positions.length > 0) });
      }
      if (p === '/api/v2/manager') return send(res, 200, load('managers-v2.json'));
      if (p === '/api/v2/constraint') return send(res, 200, load('constraints-v2.json'));

      if (p.startsWith('/api/read/itsystem/roleAssignmentsWithContraints/')) {
        if (decodeURIComponent(p.split('/').pop()) !== SYSTEM) return send(res, 404, []);
        return send(res, 200, load('role-assignments-with-constraints.json'));
      }
      const m = /^\/api\/user\/([^/]+)\/rolesAsList$/.exec(p);
      if (m) {
        const system = url.searchParams.get('system');
        if (!system) return send(res, 400);
        if (system !== SYSTEM) return send(res, 404);
        const body = rolesAsList(decodeURIComponent(m[1]));
        return body ? send(res, 200, body) : send(res, 404);
      }
      return send(res, 404);
    } catch {
      send(res, 500);
    }
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`mock-rollekatalog listening on http://127.0.0.1:${PORT} (system "${SYSTEM}")`);
  });

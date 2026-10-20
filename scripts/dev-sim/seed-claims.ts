// Pre-fills the claims-mode user list for demos. In claims mode the app has no user directory of its
// own: a person exists only after their first login, so a fresh database shows an empty Users screen.
// This logs in as the claims personas through the real login flow (OIDC, and one through SAML), so the
// rows are exactly what a real first login creates. Personas that are refused on purpose (ingen.i,
// bad.b) are not seeded. Roles shown for a person count for ROLE_CLAIMS_MAX_SECONDS (default 8 h).
// Afterwards it warms up the admin screens as admin.a: `next dev` compiles a route on its first request
// (1 to 3 s for the heavy admin ones), so doing that here makes the first human click fast.
//
//   npx tsx scripts/dev-sim/seed-claims.ts          # needs the stand-ins and the app (claims mode)
// start-app.sh runs it for you in claims mode; SIM_NO_SEED=1 turns that off.
import { AppSession } from './client';
import { SIM } from './config';

const PERSONAS: Array<{ username: string; via: 'oidc' | 'saml' }> = [
  { username: 'admin.a', via: 'oidc' },
  { username: 'super.s', via: 'saml' },
  { username: 'bruger.c', via: 'oidc' },
  { username: 'bruger.d', via: 'oidc' },
];

/** Read-only GETs that make `next dev` compile the admin pages and APIs; failures are only logged. */
const WARM_UP = [
  '/api/me',
  '/admin/brugere',
  '/admin/skabeloner',
  '/admin/log',
  '/api/admin/access/users',
  '/api/admin/access/org-units',
  '/api/admin/central-templates?status=active',
  '/api/admin/central-templates/scope',
  '/api/admin/central-templates/roles',
  '/api/admin/audit?limit=50',
];

async function warmUp(admin: AppSession) {
  const started = Date.now();
  // Sequentially: parallel requests to a route that is still compiling just queue behind each other.
  for (const path of WARM_UP) {
    const r = await admin.get(path).catch(() => null);
    if (!r || r.status >= 400) console.error(`[seed-claims] warm-up ${path}: ${r ? r.status : 'no answer'}`);
  }
  console.error(`[seed-claims] admin screens warmed up in ${Math.round((Date.now() - started) / 100) / 10} s`);
}

async function main() {
  const health = await fetch(`${SIM.appUrl}/api/health`).catch(() => null);
  if (health?.status !== 200) {
    console.error(`[seed-claims] the app does not answer at ${SIM.appUrl}; start it first`);
    process.exit(1);
  }
  let admin: AppSession | null = null;
  for (const { username, via } of PERSONAS) {
    const s = new AppSession(username);
    if (username === 'admin.a') admin = s;
    try {
      if (via === 'saml') await s.loginSaml(username);
      else await s.login(username);
      const me = await s.get('/api/me');
      console.error(`[seed-claims] ${username} (${via}): ${me.status === 200 ? `roles ${JSON.stringify(me.json?.roles)}` : `status ${me.status}`}`);
    } catch (e) {
      console.error(`[seed-claims] ${username} (${via}) failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  if (admin) await warmUp(admin);
}

main();

// Pre-fills the claims-mode user list for demos. In claims mode the app has no user directory of its
// own: a person exists only after their first login, so a fresh database shows an empty Users screen.
// This logs in as the claims personas through the real login flow (OIDC, and one through SAML), so the
// rows are exactly what a real first login creates. Personas that are refused on purpose (ingen.i,
// bad.b) are not seeded. Roles shown for a person count for ROLE_CLAIMS_MAX_SECONDS (default 8 h).
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

async function main() {
  const health = await fetch(`${SIM.appUrl}/api/health`).catch(() => null);
  if (health?.status !== 200) {
    console.error(`[seed-claims] the app does not answer at ${SIM.appUrl}; start it first`);
    process.exit(1);
  }
  for (const { username, via } of PERSONAS) {
    const s = new AppSession(username);
    try {
      if (via === 'saml') await s.loginSaml(username);
      else await s.login(username);
      const me = await s.get('/api/me');
      console.error(`[seed-claims] ${username} (${via}): ${me.status === 200 ? `roles ${JSON.stringify(me.json?.roles)}` : `status ${me.status}`}`);
    } catch (e) {
      console.error(`[seed-claims] ${username} (${via}) failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }
}

main();

// Starts the simulation stack: fake Rollekatalog, fake OIDC login, fake LLM and a control
// panel. Run from the repo root:   npx tsx scripts/dev-sim/index.ts
//   --env     print the .env block for the app under test and exit
// See docs/central-access/dev-simulation.md.
import { appEnv, controlUrl, idpUrl, llmUrl, refuseInProduction, rollekatalogUrl, samlUrl, SIM } from './config';
import { startControl } from './control';
import { startMockLlm } from './llm';
import { startMockIdp, type Persona } from './oidc';
import { startMockSamlIdp } from './saml';
import { startMockRollekatalog } from '../../src/lib/rollekatalog/mock-server';

refuseInProduction();

const DEFAULT_DB = process.env.DATABASE_URL ?? 'postgres://localhost:5432/referat_sim';

if (process.argv.includes('--env')) {
  for (const [k, v] of Object.entries(appEnv(DEFAULT_DB, process.env.SIM_ACCESS_SOURCE))) console.log(`${k}=${/\s/.test(v) ? JSON.stringify(v) : v}`);
  process.exit(0);
}

async function main() {
  const rollekatalog = await startMockRollekatalog({ port: SIM.rollekatalogPort });
  const llm = await startMockLlm();

  // Everyone Rollekatalog knows, plus people it does not, to exercise the refusal paths.
  const personas = (): Persona[] => {
    const known = rollekatalog.getData().users.map((u) => ({
      username: u.userId,
      name: u.name,
      email: u.email ?? `${u.userId}@example.dk`,
      emailVerified: true,
      note: u.disabled ? 'deaktiveret i Rollekatalog' : undefined,
    }));
    const anne = known.find((p) => p.username === 'anne.p');
    // People whose ROLES come from the IdP's claims (ACCESS_SOURCE=claims; roles, and memberOf as
    // a ';'-separated string). In the Rollekatalog mode they are simply strangers.
    const claimPeople: Persona[] = [
      { username: 'admin.a', name: 'Alma Administrator', email: 'admin.a@example.dk', emailVerified: true, note: 'claims: referat-admin', claims: { roles: ['referat-admin'], memberOf: 'G-Borgerservice;G-Okonomi' } },
      { username: 'super.s', name: 'Svend Superbruger', email: 'super.s@example.dk', emailVerified: true, note: 'claims: referat-superuser (global skabelonansvarlig)', claims: { roles: ['referat-superuser'], memberOf: 'G-Borgerservice' } },
      { username: 'log.l', name: 'Lene Logleser', email: 'log.l@example.dk', emailVerified: true, note: 'claims: referat-log', claims: { roles: ['referat-log'] } },
      { username: 'bruger.c', name: 'Carl Bruger', email: 'bruger.c@example.dk', emailVerified: true, note: 'claims: referat-bruger + en rolle appen ikke kender', claims: { roles: ['referat-bruger', 'ukendt-rolle'], memberOf: 'G-Okonomi;G-Ukendt' } },
      { username: 'bruger.d', name: 'Dorte Bruger', email: 'bruger.d@example.dk', emailVerified: true, note: 'claims: referat-bruger (holder IKKE den rolle, delte prompts rettes mod)', claims: { roles: ['referat-bruger'] } },
      { username: 'ingen.i', name: 'Ingrid Ingenrolle', email: 'ingen.i@example.dk', emailVerified: true, note: 'claims: ingen roller', claims: {} },
      { username: 'bad.b', name: 'Bent Beskadiget', email: 'bad.b@example.dk', emailVerified: true, note: 'claims: roles er et objekt (ugyldigt)', claims: { roles: { not: 'a list' } } },
    ];
    return [
      ...known,
      ...claimPeople,
      { username: 'ghost.u', name: 'Spøgelse (kun roller, ingen stilling)', email: 'ghost.u@example.dk', emailVerified: true, note: 'findes i rolletildelinger, ikke i organisationen' },
      { username: 'udenfor.p', name: 'Udenfor Person', email: 'udenfor.p@example.dk', emailVerified: true, note: 'findes slet ikke i Rollekatalog' },
      {
        username: 'imposter.x',
        name: 'Imposter (udgiver sig for Anne)',
        email: anne?.email ?? 'anne.p@example.dk',
        emailVerified: false,
        note: 'har Annes e-mail men et andet brugernavn: må ikke få hendes roller',
      },
    ];
  };
  const idp = await startMockIdp(personas);
  const samlIdp = await startMockSamlIdp(personas);
  const control = await startControl({ rollekatalog, llm, idp, samlIdp });

  console.log(`
Simulation running (Ctrl+C to stop)

  Control panel     ${controlUrl}
  Rollekatalog      ${rollekatalogUrl}   (READ key mock-read-key-0000, ORG key mock-org-key-0000)
  Login (OIDC IdP)  ${idpUrl}
  Login (SAML IdP)  ${samlUrl}   (metadata: ${SIM.saml.metadataFile})
  Fake LLM          ${llmUrl}

Point the app at it:
  npx tsx scripts/dev-sim/index.ts --env > .env.sim     # then start Next.js with these variables
  (details: docs/central-access/dev-simulation.md)
`);

  const stop = async () => {
    await Promise.all([control.close(), idp.close(), samlIdp.close(), llm.close(), rollekatalog.close()]);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('dev-sim failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});

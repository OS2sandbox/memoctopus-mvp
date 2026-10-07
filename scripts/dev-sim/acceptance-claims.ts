// Acceptance run for ACCESS_SOURCE=claims against a RUNNING simulation stack (see
// docs/central-access/dev-simulation.md, "Claims mode"). Drives the real app: login through the
// simulated OIDC and SAML IdPs, real Postgres, real routes. Prints one line per check, exits 1 on
// any failure.
//
//   SIM_ACCESS_SOURCE=claims npx tsx scripts/dev-sim/index.ts        # the stand-ins
//   SIM_ACCESS_SOURCE=claims scripts/dev-sim/start-app.sh            # the app, started AFTER them
//   npx tsx scripts/dev-sim/acceptance-claims.ts
import pg from 'pg';
import { AppSession, type Reply } from './client';
import { controlUrl, SIM } from './config';

const DB_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/referat_sim';
let failed = 0;
let passed = 0;

const heading = (name: string) => console.log(`\n── ${name}`);
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : detail ? `\n          ${detail}` : ''}`);
}
const brief = (r: Reply) => `status ${r.status} ${r.text.slice(0, 200).replace(/\s+/g, ' ')}`;
const control = (path: string, body: unknown = {}) =>
  fetch(controlUrl + path, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json().catch(() => null));
const setClaims = (username: string, claims: Record<string, unknown> | null) => control('/idp/claims', { username, claims });

async function oidc(username: string): Promise<AppSession> {
  const s = new AppSession(username);
  await s.login(username);
  return s;
}
async function saml(username: string): Promise<AppSession> {
  const s = new AppSession(username);
  await s.loginSaml(username);
  return s;
}

async function main() {
  heading('0. Stack is up, in claims mode');
  const health = await fetch(`${SIM.appUrl}/api/health`).catch(() => null);
  check('app answers /api/health', health?.status === 200, 'is the app running (SIM_ACCESS_SOURCE=claims scripts/dev-sim/start-app.sh)?');
  const state = await fetch(controlUrl + '/state').catch(() => null);
  check('control panel answers', state?.status === 200, 'is "npx tsx scripts/dev-sim/index.ts" running?');
  if (health?.status !== 200 || state?.status !== 200) return;
  for (const u of ['admin.a', 'super.s', 'log.l', 'bruger.c', 'ingen.i', 'bad.b']) await setClaims(u, null);

  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  const rolesInDb = async (email: string) =>
    (
      await db.query(
        `select ra.role_key, ra.source, ra.scope_org_unit_uuid, ra.synced_at, du.source as dir_source
           from public.role_assignments ra
           join public.directory_users du on du.uuid = ra.directory_user_uuid
           join public.users u on u.id = du.app_user_id
          where u.email = $1 order by ra.role_key`,
        [email],
      )
    ).rows;
  const externalOf = async (email: string) =>
    (
      await db.query(
        `select uer.kind, uer.identifier from public.user_external_roles uer
           join public.users u on u.id = uer.user_id where u.email = $1 order by uer.kind, uer.identifier`,
        [email],
      )
    ).rows.map((r) => `${r.kind}:${r.identifier}`);

  // ─────────────────────────────────────────────────────────────────────
  heading('1. OIDC: claims become roles');
  const admin = await oidc('admin.a');
  const meAdmin = await admin.get('/api/me');
  check('admin.a (claim referat-admin) is administrator, globally', meAdmin.json?.roles?.includes('tt-administrator') && meAdmin.json?.scopes?.['audit.read']?.global === true, brief(meAdmin));
  check('/api/me says source=claims, readOnly=true', meAdmin.json?.source === 'claims' && meAdmin.json?.readOnly === true);
  const adminRows = await rolesInDb('admin.a@example.dk');
  check('one role row, source claims, no org unit, fresh', adminRows.length === 1 && adminRows[0].source === 'claims' && adminRows[0].scope_org_unit_uuid === null && Date.now() - new Date(adminRows[0].synced_at).getTime() < 60_000, JSON.stringify(adminRows));
  check('the directory row was created by the first claims login (source claims)', adminRows[0]?.dir_source === 'claims');
  check('role and groups that are in the catalogue are stored for the person', JSON.stringify(await externalOf('admin.a@example.dk')) === JSON.stringify(['group:G-Borgerservice', 'group:G-Okonomi', 'role:referat-admin']), JSON.stringify(await externalOf('admin.a@example.dk')));
  const session = (await db.query(`select extract(epoch from (s.expires_at - s.created_at)) as left_s from public.sessions s join public.users u on u.id = s.user_id where u.email = 'admin.a@example.dk' order by s.created_at desc limit 1`)).rows[0];
  check('the session ends with the role snapshot (about ROLE_CLAIMS_MAX_SECONDS, default 8 h)', session && Math.abs(session.left_s - 8 * 3600) < 5, JSON.stringify(session));

  const bruger = await oidc('bruger.c');
  const meBruger = await bruger.get('/api/me');
  check('bruger.c: tt-bruger only; the unknown claim value grants nothing', JSON.stringify(meBruger.json?.roles) === JSON.stringify(['tt-bruger']) && !meBruger.json?.capabilities?.includes('template.manage'), brief(meBruger));
  check('values missing from the catalogue are NOT stored (privacy)', JSON.stringify(await externalOf('bruger.c@example.dk')) === JSON.stringify(['group:G-Okonomi', 'role:referat-bruger']), JSON.stringify(await externalOf('bruger.c@example.dk')));

  for (const [who, why] of [['ingen.i', 'no roles claim'], ['bad.b', 'a roles claim that is not a list']] as const) {
    const s = await oidc(who);
    const me = await s.get('/api/me');
    check(`${who} (${why}) gets no access (REQUIRE_ROLE_TO_LOGIN)`, me.status === 403, brief(me));
    check(`${who}: nothing stored for them`, (await rolesInDb(`${who}@example.dk`)).length === 0 && (await externalOf(`${who}@example.dk`)).length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────
  heading('2. A role that leaves the claims leaves the app at the next login');
  await setClaims('admin.a', { roles: ['referat-bruger'], memberOf: 'G-Okonomi' });
  const admin2 = await oidc('admin.a');
  const me2 = await admin2.get('/api/me');
  check('after the next login admin.a is only tt-bruger', JSON.stringify(me2.json?.roles) === JSON.stringify(['tt-bruger']), brief(me2));
  const stale = await admin.get('/api/me');
  check('the OLD session of the same person lost the role too (roles are read live)', JSON.stringify(stale.json?.roles) === JSON.stringify(['tt-bruger']), brief(stale));
  check('the rows were replaced, not accumulated', JSON.stringify((await rolesInDb('admin.a@example.dk')).map((r) => r.role_key)) === JSON.stringify(['tt-bruger']));
  check('so were the stored groups', JSON.stringify(await externalOf('admin.a@example.dk')) === JSON.stringify(['group:G-Okonomi', 'role:referat-bruger']));
  await setClaims('admin.a', { roles: { not: 'a list' } });
  await oidc('admin.a');
  check('a malformed claim at a later login keeps NOTHING (fail closed)', (await rolesInDb('admin.a@example.dk')).length === 0 && (await externalOf('admin.a@example.dk')).length === 0);
  await setClaims('admin.a', null);

  // ─────────────────────────────────────────────────────────────────────
  heading('3. SAML: the same, through a signed assertion');
  const superS = await saml('super.s');
  const meSuper = await superS.get('/api/me');
  check('super.s (SAML attribute referat-superuser) is a GLOBAL tt-skabelonansvarlig', meSuper.json?.roles?.includes('tt-skabelonansvarlig') && meSuper.json?.scopes?.['template.manage']?.global === true, brief(meSuper));
  check('...and has no administrator power', !meSuper.json?.capabilities?.includes('access.manage') && !meSuper.json?.capabilities?.includes('audit.export'));
  check('SAML roles are stored the same way (source claims)', (await rolesInDb('super.s@example.dk')).every((r) => r.source === 'claims') && (await rolesInDb('super.s@example.dk')).length === 1);
  check('SAML groups arrive too (delimited attribute)', JSON.stringify(await externalOf('super.s@example.dk')) === JSON.stringify(['group:G-Borgerservice', 'role:referat-superuser']), JSON.stringify(await externalOf('super.s@example.dk')));
  const idpAccount = (await db.query(`select count(*)::int as n from public.external_identities ei join public.users u on u.id = ei.user_id where u.email = 'super.s@example.dk' and ei.provider_id = 'saml'`)).rows[0].n;
  check('a SAML login leaves an external_identities snapshot (no id_token to read it from)', idpAccount === 1);
  await setClaims('super.s', {});
  await saml('super.s');
  const meSuper2 = await superS.get('/api/me');
  check('SAML: no roles attribute at the next login -> the role is gone', meSuper2.status === 403 && (await rolesInDb('super.s@example.dk')).length === 0, brief(meSuper2));
  await setClaims('super.s', null);
  const logL = await saml('log.l');
  const meLog = await logL.get('/api/me');
  check('log.l (SAML) can read and export the log', meLog.json?.capabilities?.includes('audit.read') && meLog.json?.capabilities?.includes('audit.export'), brief(meLog));

  // ─────────────────────────────────────────────────────────────────────
  heading('4. The in-app role administration is off');
  const admin3 = await oidc('admin.a'); // roles restored by the reset above
  check('admin.a is administrator again after the claims were restored', (await admin3.get('/api/me')).json?.roles?.includes('tt-administrator'));
  const users = await admin3.get('/api/admin/access/users');
  check('the user list is still readable (access.manage)', users.status === 200, brief(users));
  const target = users.json?.users?.find((u: any) => u.email === 'bruger.c@example.dk');
  const grant = await admin3.post('/api/admin/access/assignments', { appUserId: target?.id ?? 'x', roleKey: 'tt-logleser' });
  check('granting a role answers 409 read_only', grant.status === 409 && grant.json?.code === 'read_only', brief(grant));
  const unit = await admin3.post('/api/admin/access/org-units', { name: 'Ny enhed' });
  check('creating an org unit answers 409', unit.status === 409, brief(unit));
  const claimRow = adminRows[0] && (await db.query(`select id from public.role_assignments where source = 'claims' limit 1`)).rows[0];
  const revoke = await admin3.request('DELETE', `/api/admin/access/assignments/${claimRow?.id}`);
  check('revoking a claims role answers 409', revoke.status === 409, brief(revoke));
  const sync = await admin3.post('/api/admin/access/sync');
  check('the Rollekatalog sync button is not available in claims mode', sync.status === 409, brief(sync));

  // ─────────────────────────────────────────────────────────────────────
  heading('5. A password account never gets a claims role');
  const pwEmail = `pia.password.${Date.now()}@example.dk`; // unique per run: the database is not reset
  const pw = new AppSession('pw');
  const up = await pw.post('/api/auth/sign-up/email', { name: 'Pia Password', email: pwEmail, password: 'correct-horse-battery' });
  check('password sign-up works (EMAIL_PASSWORD_ENABLED=true in the sim)', up.status === 200, brief(up));
  const mePw = await pw.get('/api/me');
  check('...and the new account has no role: REQUIRE_ROLE_TO_LOGIN refuses it', mePw.status === 403, brief(mePw));
  check('no claims rows for it', (await rolesInDb(pwEmail)).length === 0);
  const taken = await new AppSession('pw2').post('/api/auth/sign-up/email', { name: 'Imposter', email: 'admin.a@example.dk', password: 'correct-horse-battery' });
  check('a password sign-up cannot take over an SSO person by e-mail', taken.status >= 400, brief(taken));

  // ─────────────────────────────────────────────────────────────────────
  heading('6. Failed SAML logins are audited, claim values never are');
  const junk = await fetch(`${SIM.appUrl}/api/auth/sso/saml2/sp/acs/${SIM.saml.providerId}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://127.0.0.1:1' },
    body: new URLSearchParams({ SAMLResponse: Buffer.from('<not-saml/>').toString('base64') }).toString(),
  });
  check('a response that is not SAML is refused (no session)', !/session_token=[^;\s]/.test(junk.headers.get('set-cookie') ?? ''), `status ${junk.status}`);
  await new Promise((r) => setTimeout(r, 500));
  const failedSaml = (await db.query(`select count(*)::int as n from public.audit_events where event_type = 'auth.login_failed' and details->>'method' = 'saml'`)).rows[0].n;
  check('auth.login_failed (method saml) was recorded', failedSaml >= 1, `${failedSaml} rows`);
  const methods = (await db.query(`select distinct details->>'method' as m from public.audit_events where event_type = 'auth.login'`)).rows.map((r) => r.m).sort();
  check('auth.login events exist for oidc and saml', methods.includes('oidc') && methods.includes('saml'), JSON.stringify(methods));
  const dump = (await db.query(`select details::text as d from public.audit_events`)).rows.map((r) => r.d).join('\n');
  const leaked = ['referat-admin', 'referat-superuser', 'referat-bruger', 'G-Borgerservice', 'G-Okonomi', 'ukendt-rolle', 'Alma', 'Svend'].filter((v) => dump.includes(v));
  check('no claim value, role name or person name is in any audit row', leaked.length === 0, leaked.join(', '));

  await db.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('acceptance-claims crashed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});

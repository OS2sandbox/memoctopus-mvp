// Acceptance run for ACCESS_SOURCE=claims against a RUNNING simulation stack (see
// docs/central-access/dev-simulation.md, "Claims mode"). Drives the real app: login through the
// simulated OIDC and SAML IdPs, real Postgres, real routes. Prints one line per check, exits 1 on
// any failure.
//
//   SIM_ACCESS_SOURCE=claims npx tsx scripts/dev-sim/index.ts        # the stand-ins
//   SIM_ACCESS_SOURCE=claims scripts/dev-sim/start-app.sh            # the app, started AFTER them
//   npx tsx scripts/dev-sim/acceptance-claims.ts
import { randomBytes } from 'node:crypto';
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
const segments = [
  { speaker: 'A', start: 0, end: 5, text: 'Vi drøftede budgettet.' },
  { speaker: 'B', start: 5, end: 9, text: 'Det blev besluttet at fortsætte.' },
];
const want = (name: string, r: Reply, status: number | number[]) =>
  check(name, (Array.isArray(status) ? status : [status]).includes(r.status), brief(r));
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
  for (const u of ['admin.a', 'super.s', 'log.l', 'bruger.c', 'bruger.d', 'ingen.i', 'bad.b']) await setClaims(u, null);
  await control('/reset');

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
  heading('5. Claims mode is not open: nobody can register a password account');
  const pwEmail = `pia.password.${Date.now()}@example.dk`; // unique per run: the database is not reset
  const pw = new AppSession('pw');
  const up = await pw.post('/api/auth/sign-up/email', { name: 'Pia Password', email: pwEmail, password: 'correct-horse-battery' });
  check('password sign-up is refused even with EMAIL_PASSWORD_ENABLED=true (sign-up is closed in claims mode)', up.status >= 400, brief(up));
  const mePw = await pw.get('/api/me');
  check('...so there is no session and nothing to access', mePw.status === 401, brief(mePw));
  check('no user and no claims rows for it', (await db.query('select 1 from public.users where email = $1', [pwEmail])).rows.length === 0 && (await rolesInDb(pwEmail)).length === 0);
  const taken = await new AppSession('pw2').post('/api/auth/sign-up/email', { name: 'Imposter', email: 'admin.a@example.dk', password: 'correct-horse-battery' });
  check('a password sign-up cannot take over an SSO person by e-mail', taken.status >= 400, brief(taken));

  // ─────────────────────────────────────────────────────────────────────
  heading('6. Shared prompts by role and group (organisation-wide, no org units)');
  const llmCalls = async (): Promise<Array<{ system: string; user: string }>> => (await fetch(controlUrl + '/llm/calls')).json();
  const SECRET = `HEMMELIG-${randomBytes(6).toString('hex')}`;
  const NOTE = 'Første version af skabelonen til sagsbehandlere.';
  // super.s signs in through SAML (the account was created there); their roles were restored by section 3's reset.
  const superUser = await saml('super.s');
  const adminUser = await oidc('admin.a');

  const cat0 = await superUser.get('/api/admin/central-templates/roles');
  want('the superuser reads the catalogue (config entries are there from the start)', cat0, 200);
  check('it is global (canTarget) but may not refresh (no sync.run)', cat0.json?.canTarget === true && cat0.json?.canRefresh === false, JSON.stringify({ t: cat0.json?.canTarget, r: cat0.json?.canRefresh }));
  check('the config catalogue is merged in, with names', (cat0.json?.roles ?? []).some((r: any) => r.kind === 'role' && r.identifier === 'referat-bruger' && r.source === 'config' && r.name === 'Referat: bruger'));
  check('the administrator may refresh (sync.run and a READ key are configured)', (await adminUser.get('/api/admin/central-templates/roles')).json?.canRefresh === true);

  want('a superuser cannot refresh the catalogue (sync.run is for administrators)', await superUser.post('/api/admin/central-templates/roles/refresh'), 403);
  const noCron = await fetch(`${SIM.appUrl}/api/internal/rollekatalog/roles`, { method: 'POST', headers: { 'X-Cron-Secret': 'wrong' } });
  check('the cron route refuses a wrong secret', noCron.status === 401, `status ${noCron.status}`);
  const cron = (await control('/roles/refresh')) as { httpStatus: number; body: any } | null;
  // A re-run on the same database updates instead of adding.
  const cc = cron?.body?.counts;
  check('the cron route refreshes the catalogue from the mock Rollekatalog (READ key, GET only)', cron?.httpStatus === 200 && cc?.fetched === 6 && cc.added + cc.updated === 6, JSON.stringify(cron));
  const cat1 = await adminUser.get('/api/admin/central-templates/roles');
  const rk = (cat1.json?.roles ?? []).filter((r: any) => r.source === 'rollekatalog');
  check('user roles (jobfunktionsroller) and role groups are in the catalogue, by name', rk.some((r: any) => r.kind === 'role' && r.identifier === 'sagsbehandler' && r.name === 'Sagsbehandler') && rk.some((r: any) => r.kind === 'group' && r.identifier === '11'), JSON.stringify(rk));
  check('nothing but kind, identifier, name, source and active is exposed', rk.every((r: any) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['active', 'identifier', 'kind', 'name', 'source'])));
  const viaButton = await adminUser.post('/api/admin/central-templates/roles/refresh');
  check('the admin button works too, and a second refresh adds nothing', viaButton.status === 200 && viaButton.json?.counts?.added === 0, brief(viaButton));

  // bruger.c holds the role "sagsbehandler" (and group 11) at their next login; bruger.d does not.
  await setClaims('bruger.c', { roles: ['referat-bruger', 'sagsbehandler'], memberOf: 'G-Okonomi;11' });
  const brugerC = await oidc('bruger.c');
  const brugerD = await oidc('bruger.d');
  check('the catalogue values the IdP claimed are stored for the person (and nothing else)', JSON.stringify(await externalOf('bruger.c@example.dk')) === JSON.stringify(['group:11', 'group:G-Okonomi', 'role:referat-bruger', 'role:sagsbehandler']), JSON.stringify(await externalOf('bruger.c@example.dk')));

  const bad = await superUser.post('/api/admin/central-templates', { name: 'x', prompt: SECRET, targets: [], principalTargets: [{ kind: 'role', identifier: 'ukendt-rolle' }], changeNote: NOTE });
  check('a role that is not in the catalogue cannot be a target', bad.status === 400 && bad.json?.code === 'principal_target_unknown', brief(bad));
  want('a plain user cannot create shared prompts', await brugerC.post('/api/admin/central-templates', { name: 'x', prompt: 'p', targets: [], changeNote: NOTE }), 403);

  const created = await superUser.post('/api/admin/central-templates', {
    name: `Sagsbehandlerreferat ${randomBytes(3).toString('hex')}`,
    description: 'Til sagsbehandlere',
    prompt: `Skriv et referat for sagsbehandlere. ${SECRET}`,
    includeDeltagere: true,
    targets: [],
    principalTargets: [{ kind: 'role', identifier: 'sagsbehandler' }],
    changeNote: NOTE,
  });
  want('the superuser creates an organisation-wide template targeted at a ROLE (no owner unit)', created, 201);
  const tid: string = created.json?.template?.id;
  check('it has no owner unit, and the audience is named', created.json?.template?.ownerOrgUnitUuid === null && created.json?.template?.principalTargets?.[0]?.name === 'Sagsbehandler', brief(created));
  const listed = await superUser.get('/api/admin/central-templates?status=all');
  check('the list names the audience (kind, name, state)', JSON.stringify(listed.json?.templates?.find((t: any) => t.id === tid)?.principalTargets) === JSON.stringify([{ kind: 'role', identifier: 'sagsbehandler', name: 'Sagsbehandler', status: 'active' }]), brief(listed));

  const mine = await brugerC.get('/api/skabeloner');
  check('bruger.c (holds the role) sees it in the picker without configuring anything, and never its prompt', mine.json?.centralSkabeloner?.some((t: any) => t.id === tid) && !mine.text.includes(SECRET), brief(mine));
  await control('/llm/clear');
  const gen = await brugerC.post('/api/minutes', { segments, skabelonId: tid, skabelonSource: 'central', includeDeltagere: true });
  want('...and can generate minutes with it', gen, 200);
  const sent = (await llmCalls()).at(-1);
  check('the LLM got the stored prompt in the system message, the response does not echo it', !!sent?.system.includes(SECRET) && !gen.text.includes(SECRET));
  const theirs = await brugerD.get('/api/skabeloner');
  check('bruger.d (without the role) does not see it', !theirs.json?.centralSkabeloner?.some((t: any) => t.id === tid), brief(theirs));
  const denied = await brugerD.post('/api/minutes', { segments, skabelonId: tid, skabelonSource: 'central' });
  const madeUp = await brugerD.post('/api/minutes', { segments, skabelonId: '00000000-0000-4000-8000-0000000000aa', skabelonSource: 'central' });
  check('...and gets the very same 404 as for an id that does not exist', denied.status === 404 && madeUp.status === 404 && denied.text === madeUp.text, `${brief(denied)} | ${brief(madeUp)}`);
  want('a user cannot open it in the manager admin', await brugerC.get(`/api/admin/central-templates/${tid}`), 403);

  // Change of audience is live: retarget to the GROUP, then to nobody.
  const retarget = await superUser.request('PUT', `/api/admin/central-templates/${tid}`, { baseVersion: 1, changeNote: 'Flytter målgruppen til rollebukken.', principalTargets: [{ kind: 'group', identifier: '11' }] });
  want('the superuser changes the audience to a role group', retarget, 200);
  check('bruger.c holds that group too and keeps it, bruger.d still does not have it', (await brugerC.post('/api/minutes', { segments, skabelonId: tid, skabelonSource: 'central' })).status === 200 && (await brugerD.post('/api/minutes', { segments, skabelonId: tid, skabelonSource: 'central' })).status === 404);
  want('withdrawing the audience entirely', await superUser.request('PUT', `/api/admin/central-templates/${tid}`, { baseVersion: 2, changeNote: 'Trækker adgangen tilbage til alle.', principalTargets: [] }), 200);
  want('...bruger.c loses it at once (404)', await brugerC.post('/api/minutes', { segments, skabelonId: tid, skabelonSource: 'central' }), 404);
  want('an update by one place reaches everyone: re-add the role', await superUser.request('PUT', `/api/admin/central-templates/${tid}`, { baseVersion: 3, changeNote: 'Giver sagsbehandlerne adgang igen.', prompt: `Opdateret prompt. ${SECRET}`, principalTargets: [{ kind: 'role', identifier: 'sagsbehandler' }] }), 200);
  check('bruger.c has the new version without doing anything', (await brugerC.get('/api/skabeloner')).json?.centralSkabeloner?.find((t: any) => t.id === tid)?.version === 4);
  const history = await superUser.get(`/api/admin/central-templates/${tid}/versions`);
  check('the changelog names the audience of each version', history.json?.versions?.length === 4 && history.json.versions[0].principalTargets?.[0]?.name === 'Sagsbehandler' && history.json.versions[1].principalTargets?.length === 0, brief(history));

  // The catalogue withdraws the role: nobody matches it any more, the template keeps the (flagged) target.
  await control('/roles', { userRoles: [{ id: 101, name: 'Anden rolle', identifier: 'anden', description: '', itSystemName: 'S' }, { id: 103, name: 'Leder', identifier: 'leder', description: '', itSystemName: 'S' }] });
  const refreshed = (await control('/roles/refresh')) as { httpStatus: number; body: any } | null;
  check('a refresh without "sagsbehandler" deactivates it (never deletes)', refreshed?.httpStatus === 200 && refreshed.body?.counts?.deactivated >= 1, JSON.stringify(refreshed));
  want('bruger.c no longer receives the template (the catalogue entry is withdrawn)', await brugerC.post('/api/minutes', { segments, skabelonId: tid, skabelonSource: 'central' }), 404);
  const flagged = await superUser.get('/api/admin/central-templates?status=all');
  check('the manager sees the withdrawn target flagged as inactive', flagged.json?.templates?.find((t: any) => t.id === tid)?.principalTargets?.[0]?.status === 'inactive', brief(flagged));
  await control('/reset');
  await control('/roles/refresh');
  check('when it returns to Rollekatalog, the entry is active again and bruger.c has the template', (await brugerC.post('/api/minutes', { segments, skabelonId: tid, skabelonSource: 'central' })).status === 200);

  const arch = await superUser.post(`/api/admin/central-templates/${tid}/archive`, { baseVersion: 4, changeNote: 'Udgår, erstattes af en ny skabelon.' });
  want('archive ("fjerner for alle") withdraws it', arch, 200);
  want('...for the recipient too', await brugerC.post('/api/minutes', { segments, skabelonId: tid, skabelonSource: 'central' }), 404);
  want('restore brings it back', await superUser.post(`/api/admin/central-templates/${tid}/restore`, { baseVersion: 5, changeNote: 'Genopretter, den skulle alligevel bruges.' }), 200);
  want('...to the role holder', await brugerC.post('/api/minutes', { segments, skabelonId: tid, skabelonSource: 'central' }), 200);

  const events = (await db.query(`select event_type, details::text as d, secondary_entity_id from public.audit_events where event_type like 'central_template.%'`)).rows;
  const kinds = new Set(events.map((e) => e.event_type));
  check('create, retarget, update, archive and restore are in the log', ['central_template.create', 'central_template.retarget', 'central_template.update', 'central_template.archive', 'central_template.restore'].every((t) => kinds.has(t)), [...kinds].join(', '));
  check('the org-wide template has no owner unit in the log, and only counts for the audience', events.every((e) => e.secondary_entity_id === null) && events.every((e) => !/sagsbehandler|Sagsbehandler|"11"/.test(e.d)), events.map((e) => e.d).join(' '));

  // ─────────────────────────────────────────────────────────────────────
  heading('7. A person\'s own template changelog');
  const own = await brugerC.post('/api/skabeloner', { name: 'Min egen skabelon', prompt: 'Skriv kort.' });
  want('bruger.c creates a private template (still possible beside the shared ones)', own, [200, 201]);
  const ownId: string = own.json?.skabelon?.id;
  const PRIVATE_NOTE = `Strammet op efter mødet ${randomBytes(3).toString('hex')}`;
  want('an edit with an optional note', await brugerC.put(`/api/skabeloner/${ownId}`, { name: 'Min egen skabelon', prompt: 'Skriv meget kort.', changeNote: PRIVATE_NOTE }), 200);
  want('an edit without a note works too', await brugerC.put(`/api/skabeloner/${ownId}`, { name: 'Min egen skabelon', prompt: 'Skriv kort og præcist.' }), 200);
  const own404 = await brugerD.get(`/api/skabeloner/${ownId}/history`);
  check('nobody else can read the history', own404.status === 404, brief(own404));
  const hist = await brugerC.get(`/api/skabeloner/${ownId}/history`);
  check('the own history lists versions newest first, with the note and the changed field names', hist.json?.versions?.length === 3 && hist.json.versions[1].changeNote === PRIVATE_NOTE && hist.json.versions[1].changedFields?.includes('prompt') && hist.json.versions[0].changeNote === null, brief(hist));
  const updates = (await db.query(`select details::text as d from public.audit_events where event_type = 'template.update'`)).rows.map((r) => r.d);
  check('the audit log says only THAT a note was written, never the note', updates.some((d) => d.includes('"hasChangeNote": true')) && updates.every((d) => !d.includes(PRIVATE_NOTE)), updates.join(' '));
  check('the note is nowhere in the shared schema', (await db.query(`select count(*)::int as n from public.audit_events where details::text like $1 or entity_id::text like $1`, [`%${PRIVATE_NOTE}%`])).rows[0].n === 0);

  // ─────────────────────────────────────────────────────────────────────
  heading('8. Failed SAML logins are audited, claim values never are');
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
  const leaked = ['referat-admin', 'referat-superuser', 'referat-bruger', 'G-Borgerservice', 'G-Okonomi', 'ukendt-rolle', 'Alma', 'Svend', 'sagsbehandler', 'Sagsbehandler', 'Sagsbehandlerreferat', 'Strammet op'].filter((v) => dump.includes(v));
  check('no claim value, role name or person name is in any audit row', leaked.length === 0, leaked.join(', '));

  await db.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('acceptance-claims crashed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});

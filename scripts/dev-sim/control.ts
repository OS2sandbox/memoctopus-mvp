// Control panel for the simulation: change what "Rollekatalog" says, break it on purpose,
// switch the fake LLM's behaviour, and trigger the app's sync. JSON API plus one small page.
// TEST ONLY, no authentication: it binds to 127.0.0.1.
import http from 'node:http';
import { SIM } from './config';
import type { MockLlm, LlmMode } from './llm';
import type { MockIdp } from './oidc';
import type { MockSamlIdp } from './saml';
import type { MockData, MockFault, MockRollekatalog } from '../../src/lib/rollekatalog/mock-server';

type Json = Record<string, any>;
const ITSYSTEM_CONSTRAINT = 'http://digital-identity.dk/constraints/orgunit/1';

interface RoleSpec {
  role: string;
  orgUnitUuids?: string[];
}

/** Rows of roleAssignmentsWithContraints for one user, from a compact role list. */
function toAssignments(roles: RoleSpec[]) {
  return roles.map((r) => ({
    roleIdentifier: r.role,
    roleName: r.role,
    roleConstraintValues: r.orgUnitUuids?.length
      ? [{ constraintType: ITSYSTEM_CONSTRAINT, constraintValues: r.orgUnitUuids }]
      : [],
  }));
}

function summarise(data: MockData) {
  const assignmentsByUser = new Map<string, any[]>();
  for (const row of data.roleAssignments as Json[]) assignmentsByUser.set(row.userId, row.assignments ?? []);
  const unitName = new Map((data.orgUnits as Json[]).map((u) => [u.uuid, u.name]));
  const rolesOf = (userId: string) =>
    (assignmentsByUser.get(userId) ?? []).map((a) => ({
      role: a.roleIdentifier,
      orgUnits: (a.roleConstraintValues ?? [])
        .filter((c: Json) => /orgunit|orgenhed/.test(c.constraintType))
        .flatMap((c: Json) => c.constraintValues)
        .map((u: string) => ({ uuid: u, name: unitName.get(u) ?? '(ukendt enhed)' })),
    }));
  const known = new Set(data.users.map((u) => u.userId));
  return {
    orgUnits: (data.orgUnits as Json[]).map((u) => ({ uuid: u.uuid, name: u.name, parent: u.parentOrgUnitUuid ?? null })),
    users: [
      ...data.users.map((u) => ({
        userId: u.userId,
        name: u.name,
        email: u.email,
        disabled: u.disabled,
        inExport: u.positions.length > 0,
        units: u.positions.map((p) => unitName.get(p.orgUnitUuid) ?? p.orgUnitUuid),
        roles: rolesOf(u.userId),
      })),
      // Assignments for people the organisation export does not list.
      ...[...assignmentsByUser.keys()]
        .filter((id) => !known.has(id))
        .map((id) => ({ userId: id, name: '(kun i rolletildelinger)', email: null, disabled: false, inExport: false, units: [], roles: rolesOf(id) })),
    ],
  };
}

// Ids for people added at runtime. The 9000 block keeps them clear of the fixture ids (…8000-0000000000nn).
let seq = 0;
const newUuid = (prefix: string) => `${prefix}0000-0000-4000-9000-${String(++seq).padStart(12, '0')}`;

export interface ControlDeps {
  rollekatalog: MockRollekatalog;
  llm: MockLlm;
  idp: MockIdp;
  samlIdp: MockSamlIdp;
}

export async function startControl({ rollekatalog, llm, idp, samlIdp }: ControlDeps): Promise<{ close(): Promise<void> }> {
  const readJson = (req: http.IncomingMessage) =>
    new Promise<Json>((resolve) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => {
        try {
          resolve(s ? JSON.parse(s) : {});
        } catch {
          resolve({});
        }
      });
    });

  function mutate(fn: (d: MockData) => void) {
    const d = structuredClone(rollekatalog.getData());
    fn(d);
    rollekatalog.setData(d);
  }

  const faultFor = (kind: string, ms?: number): MockFault[] => {
    switch (kind) {
      case 'down':
        return [{ match: '/api/', status: 500 }];
      case 'unauthorized':
        return [{ match: '/api/', status: 401 }];
      case 'forbidden':
        return [{ match: '/api/', status: 403 }];
      case 'invalid_json':
        return [{ match: '/api/', invalidJson: true }];
      case 'slow':
        return [{ match: '/api/', delayMs: ms ?? 15_000 }];
      default:
        return [];
    }
  };
  let activeFault = 'none';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', controlUrlBase());
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const ok = () => send(200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/') return send(200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/state') {
      return send(200, {
        ...summarise(rollekatalog.getData()),
        fault: activeFault,
        llmMode: llm.mode,
        requests: rollekatalog.requests.slice(-40),
        llmCalls: llm.calls.length,
        idpLogins: idp.logins.slice(-20),
        samlLogins: samlIdp.logins.slice(-20),
      });
    }
    if (req.method === 'GET' && url.pathname === '/llm/calls') return send(200, llm.calls);
    if (req.method !== 'POST') return send(404, { error: 'not_found' });

    const body = await readJson(req);
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/reset') {
      rollekatalog.resetData();
      rollekatalog.setFaults([]);
      rollekatalog.clearRequests();
      activeFault = 'none';
      llm.mode = 'ok';
      llm.calls.length = 0;
      return ok();
    }
    if (url.pathname === '/fault') {
      activeFault = String(body.kind ?? 'none');
      rollekatalog.setFaults(faultFor(activeFault, body.ms));
      return ok();
    }
    if (url.pathname === '/llm') {
      llm.mode = body.mode as LlmMode;
      return ok();
    }
    // What the IdPs (OIDC and SAML) claim about one person from now on, e.g. { username, claims: { roles: [...] } };
    // claims null restores the persona's own. For the claims mode.
    if (url.pathname === '/idp/claims') {
      const username = String(body.username ?? '');
      const claims = body.claims && typeof body.claims === 'object' ? (body.claims as Record<string, unknown>) : null;
      idp.setClaims(username, claims);
      samlIdp.setClaims(username, claims);
      return ok();
    }
    if (url.pathname === '/llm/clear') {
      llm.calls.length = 0;
      return ok();
    }
    // Rows that fail the app's whitelist schemas (a user whose uuid is not a uuid).
    if (url.pathname === '/corrupt') {
      const n = Math.max(0, Math.min(500, Number(body.users ?? 0)));
      mutate((d) => {
        for (let i = 0; i < n; i++) {
          d.users.push({
            uuid: `not-a-uuid-${i}`, extUuid: null, userId: `broken${i}`, name: 'Ødelagt', email: null,
            disabled: false, positions: [{ orgUnitUuid: (d.orgUnits[0] as Json).uuid }],
          });
        }
      });
      return ok();
    }
    if (url.pathname === '/empty') {
      mutate((d) => {
        d.users = [];
        d.orgUnits = [];
        d.roleAssignments = [];
      });
      return ok();
    }
    // Calls the APP's cron route, exactly like a scheduler would.
    if (url.pathname === '/sync') {
      try {
        const r = await fetch(`${SIM.appUrl}/api/internal/rollekatalog/sync`, {
          method: 'POST',
          headers: { 'X-Cron-Secret': SIM.cronSecret },
        });
        return send(200, { httpStatus: r.status, body: await r.json().catch(() => null) });
      } catch {
        return send(200, { httpStatus: 0, body: { error: 'appen svarer ikke på ' + SIM.appUrl } });
      }
    }

    // The role/group CATALOGUE the mock Rollekatalog serves (user roles with identifier, role groups),
    // for the claims mode; either list may be left out. The app picks it up on its next refresh.
    if (url.pathname === '/roles') {
      const part: { userRoles?: unknown[]; roleGroups?: unknown[] } = {};
      if (Array.isArray(body.userRoles)) part.userRoles = body.userRoles;
      if (Array.isArray(body.roleGroups)) part.roleGroups = body.roleGroups;
      rollekatalog.setData(part);
      return ok();
    }
    // Calls the APP's catalogue cron route, exactly like a scheduler would.
    if (url.pathname === '/roles/refresh') {
      try {
        const r = await fetch(`${SIM.appUrl}/api/internal/rollekatalog/roles`, {
          method: 'POST',
          headers: { 'X-Cron-Secret': SIM.cronSecret },
        });
        return send(200, { httpStatus: r.status, body: await r.json().catch(() => null) });
      } catch {
        return send(200, { httpStatus: 0, body: { error: 'appen svarer ikke på ' + SIM.appUrl } });
      }
    }

    if (url.pathname === '/user') {
      const { userId, name, email, orgUnitUuid, roles } = body;
      if (!userId || !orgUnitUuid) return send(400, { error: 'userId og orgUnitUuid kræves' });
      mutate((d) => {
        const uuid = newUuid('7e5e');
        const extUuid = newUuid('9d3c');
        d.users.push({
          uuid, extUuid, userId, name: name ?? userId, email: email ?? `${userId}@example.dk`,
          disabled: false, positions: [{ orgUnitUuid }],
        });
        (d.roleAssignments as Json[]).push({ extUuid, userId, assignments: toAssignments(roles ?? [{ role: 'bruger' }]) });
      });
      return ok();
    }
    if (parts[0] === 'user' && parts[1]) {
      const userId = decodeURIComponent(parts[1]);
      const action = parts[2];
      mutate((d) => {
        const u = d.users.find((x) => x.userId === userId);
        if (action === 'disabled' && u) u.disabled = body.disabled === true;
        if (action === 'remove' && u) u.positions = []; // v3 only exports users with a position
        if (action === 'roles') {
          const row = (d.roleAssignments as Json[]).find((r) => r.userId === userId);
          const assignments = toAssignments((body.roles ?? []) as RoleSpec[]);
          if (row) row.assignments = assignments;
          else (d.roleAssignments as Json[]).push({ extUuid: u?.extUuid ?? newUuid('9d3c'), userId, assignments });
        }
      });
      return ok();
    }
    if (parts[0] === 'orgunit' && parts[1]) {
      mutate((d) => {
        const u = (d.orgUnits as Json[]).find((x) => x.uuid === parts[1]);
        if (!u) return;
        if (typeof body.name === 'string') u.name = body.name;
        if ('parentOrgUnitUuid' in body) u.parentOrgUnitUuid = body.parentOrgUnitUuid;
      });
      return ok();
    }
    send(404, { error: 'not_found' });
  });

  function controlUrlBase() {
    return `http://127.0.0.1:${SIM.controlPort}`;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(SIM.controlPort, '127.0.0.1', resolve);
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Rollekatalog-simulator</title>
<style>
 body{font:15px system-ui;margin:1.5rem auto;max-width:78rem;padding:0 1rem;color:#1a1a1a}
 h1{margin-bottom:.2rem} h2{margin-top:1.8rem;font-size:1.05rem}
 table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #ddd;padding:.3rem .5rem;text-align:left;vertical-align:top}
 button{cursor:pointer;margin:.15rem .2rem .15rem 0;padding:.25rem .6rem}
 .chip{display:inline-block;background:#eef;border-radius:.6rem;padding:0 .5rem;margin:.1rem}
 .bad{color:#b00020} pre{background:#f6f6f6;padding:.6rem;overflow:auto;max-height:16rem}
 .row{display:flex;gap:2rem;flex-wrap:wrap}
</style>
<h1>Rollekatalog-simulator</h1>
<p>Ændringer her er "Rollekatalog" set fra appen. De får først effekt, når appen har synkroniseret (knappen nedenfor).
Login-siden for appen findes på appens adresse; her vælger du kun, hvad Rollekatalog <i>siger</i>.</p>

<h2>Handlinger</h2>
<div id="actions"></div>
<h2>Synkronisering</h2>
<button onclick="syncNow()">Synkronisér appen nu (kalder cron-ruten)</button>
<pre id="syncOut">(endnu ikke kørt)</pre>

<h2>Personer og roller i Rollekatalog</h2>
<table id="people"></table>
<div class="row"><div><h2>Organisation</h2><table id="units"></table></div>
<div><h2>Seneste kald fra appen til Rollekatalog</h2><pre id="reqs"></pre></div></div>
<h2>Test-LLM</h2>
<p>Tilstand: <b id="llmMode"></b> · registrerede kald: <b id="llmCalls"></b>
 <button onclick="post('/llm',{mode:'ok'})">Normal</button>
 <button onclick="post('/llm',{mode:'echo-system'})">Gentager hele system-prompten</button>
 <button onclick="post('/llm',{mode:'echo-system-chunk'})">Gentager 200 tegn af system-prompten</button>
 <button onclick="showLlm()">Vis hvad appen sendte</button></p>
<pre id="llmOut"></pre>
<script>
const U={mette:'5a1b0000-0000-4000-8000-000000000001',borger:'5a1b0000-0000-4000-8000-000000000002',team:'5a1b0000-0000-4000-8000-000000000003',okonomi:'5a1b0000-0000-4000-8000-000000000004',support:'5a1b0000-0000-4000-8000-000000000005'};
const ACTIONS=[
 ['Nulstil alt til udgangspunkt','/reset',{}],
 ['Anne mister bygger-rollen','/user/anne.p/roles',{roles:[{role:'bruger'}]}],
 ['Jens deaktiveres','/user/jens.t/disabled',{disabled:true}],
 ['Jens aktiveres igen','/user/jens.t/disabled',{disabled:false}],
 ['Lars fjernes fra organisationen','/user/lars.f/remove',{}],
 ['Ny bruger bruger.b i Digital Support','/user',{userId:'bruger.b',name:'Bente Bruger',orgUnitUuid:U.support,roles:[{role:'bruger'}]}],
 ['Digital Support flyttes under Økonomi','/orgunit/'+U.support,{parentOrgUnitUuid:U.okonomi}],
 ['Team Selvbetjening omdøbes','/orgunit/'+U.team,{name:'Team Selvbetjening (omdøbt)'}],
 ['Fejl: Rollekatalog nede (500)','/fault',{kind:'down'}],
 ['Fejl: forkert API-nøgle (401)','/fault',{kind:'unauthorized'}],
 ['Fejl: ugyldigt JSON','/fault',{kind:'invalid_json'}],
 ['Fejl: langsomt svar (15 s)','/fault',{kind:'slow',ms:15000}],
 ['Ingen fejl','/fault',{kind:'none'}],
 ['Tomt svar fra Rollekatalog','/empty',{}],
 ['2 ødelagte brugerrækker','/corrupt',{users:2}],
 ['30 ødelagte brugerrækker','/corrupt',{users:30}],
];
document.getElementById('actions').innerHTML=ACTIONS.map((a,i)=>'<button onclick="run('+i+')">'+a[0]+'</button>').join('');
async function post(p,b){await fetch(p,{method:'POST',body:JSON.stringify(b||{})});load()}
function run(i){post(ACTIONS[i][1],ACTIONS[i][2])}
async function syncNow(){const r=await (await fetch('/sync',{method:'POST'})).json();document.getElementById('syncOut').textContent=JSON.stringify(r,null,2);load()}
async function showLlm(){const c=await (await fetch('/llm/calls')).json();document.getElementById('llmOut').textContent=c.length?JSON.stringify(c.slice(-2),null,2):'(ingen kald endnu)'}
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>'&#'+c.charCodeAt(0)+';');
async function load(){
 const s=await (await fetch('/state')).json();
 document.getElementById('people').innerHTML='<tr><th>Bruger</th><th>Navn</th><th>Enhed(er)</th><th>Roller (scope)</th><th></th></tr>'+s.users.map(u=>
  '<tr><td><code>'+esc(u.userId)+'</code>'+(u.disabled?' <span class=bad>deaktiveret</span>':'')+(u.inExport?'':' <i>(ikke i org-udtræk)</i>')+'</td><td>'+esc(u.name)+'</td><td>'+esc(u.units.join(', '))+'</td><td>'+
  (u.roles.length?u.roles.map(r=>'<span class=chip>'+esc(r.role)+(r.orgUnits.length?' → '+esc(r.orgUnits.map(o=>o.name).join(', ')):'')+'</span>').join(''):'<i>ingen</i>')+'</td></tr>').join('');
 document.getElementById('units').innerHTML=s.orgUnits.map(o=>'<tr><td>'+esc(o.name)+'</td><td><small>under: '+esc((s.orgUnits.find(p=>p.uuid===o.parent)||{}).name||'—')+'</small></td></tr>').join('');
 document.getElementById('reqs').textContent=s.requests.map(r=>r.method+' '+r.path+' → '+r.status+' ('+r.keyRole+' key)').join('\\n')||'(ingen)';
 document.getElementById('llmMode').textContent=s.llmMode;document.getElementById('llmCalls').textContent=s.llmCalls;
}
load();setInterval(load,4000);
</script>`;

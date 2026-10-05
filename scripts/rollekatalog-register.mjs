#!/usr/bin/env node
// One-off, idempotent registration of this app's IT system and its four system roles
// in OS2rollekatalog. Run it ONCE from an operator's shell; the app itself never uses
// the key this script needs and never calls a Rollekatalog write endpoint.
//
// Usage (dry-run is the default and writes nothing):
//   ROLLEKATALOG_URL=https://rollekatalog.example.dk \
//   ROLLEKATALOG_ITSYSTEM_API_KEY=<temporary ITSYSTEM client key> \
//   node scripts/rollekatalog-register.mjs            # prints the plan
//   ... node scripts/rollekatalog-register.mjs --apply  # creates what is missing
//
// Environment (read from the shell only, never from the app's .env, never stored):
//   ROLLEKATALOG_URL               required, https:// (plain http only for localhost/127.0.0.1/::1,
//                                  or ROLLEKATALOG_ALLOW_HTTP=true)
//   ROLLEKATALOG_ITSYSTEM_API_KEY  required, sent as the `ApiKey` header, never printed
//   ROLLEKATALOG_ITSYSTEM_ID       identifier of the IT system (default os2taletiltekst)
//   ROLLEKATALOG_ITSYSTEM_NAME     display name when the IT system is created (default from system-roles.json)
//   ROLLEKATALOG_TIMEOUT_MS        per request (default 10000)
//
// Exit codes: 0 ok (also when drift is reported), 1 failure, 2 usage/configuration.
//
// What it does: matches by identifier. Missing IT system / system roles are created, existing ones
// are left alone and name/description/weight/constraint differences are reported as drift, never
// overwritten. Role data comes from src/lib/rollekatalog/system-roles.json.
//
// Before running, the municipality creates three API clients in Rollekatalog:
//   - READ_ACCESS      -> ROLLEKATALOG_READ_API_KEY (app, login check + bulk assignments)
//   - ORGANISATION     -> ROLLEKATALOG_ORG_API_KEY  (app, organisation + managers)
//   - ITSYSTEM         -> only for this script; delete the client once registration is done
// Afterwards a Rollekatalog administrator must, in the Rollekatalog UI: build a UserRole from each
// system role (IT system "os2taletiltekst") and assign it by org unit / title / person. For
// tt-skabelonansvarlig and tt-logleser, pick the org unit as the constraint value: under the default
// ROLLEKATALOG_SCOPE_STRATEGY=constraint an assignment without a unit grants no elevated access.
//
// Verified from the OS2rollekatalog 2026r4 source (ItSystemApiV2, SystemRoleAM, ConstraintTypeSupportAM,
// RoleMapper, ApiSecurityFilter); NOT verified against a live server:
//   - POST /api/v2/itsystem takes an ItSystemRecord (200); systemtype SAML. Listing: GET /api/v2/itsystem.
//   - POST /api/v2/itsystem/{id}/systemroles takes a SystemRoleAM (201); listing: GET .../systemroles.
//   - supportedConstraintTypes is [{constraintType: ConstraintTypeAM, mandatory}]; the mapper copies the
//     whole object and the database link is the numeric constraintType.id, so the object (with its id)
//     is taken from GET /api/v2/constraint, matched on entityId
//     http://digital-identity.dk/constraints/orgunit/1, never guessed.
//   - Constraint types cannot be changed by PUT, and roleType is not part of SystemRoleAM: roles are
//     created with Rollekatalog's default roleType (BOTH). The app reads systemRoles and does not depend on it.
//   - All roles get weight 1 on purpose: Rollekatalog's rolesAsList drops system roles below the highest
//     weight in an IT system, and our roles are not a ladder.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const MAX_BYTES = 16 * 1024 * 1024;
const IDENTIFIER_RE = /^[A-Za-z0-9_-]+$/;

class Usage extends Error {}
class Failure extends Error {
  constructor(code, step, status) {
    super(`${code}`);
    this.code = code;
    this.step = step;
    this.status = status ?? null;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const definitionPath = path.join(here, '..', 'src', 'lib', 'rollekatalog', 'system-roles.json');

function parseArgs(argv) {
  const opts = { apply: false, help: false };
  for (const a of argv) {
    if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.apply = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Usage(`Ukendt argument: ${a}`);
  }
  return opts;
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

// Same rule as the app (src/lib/rollekatalog/config.ts): the key must not travel in cleartext by accident.
function readConfig(env) {
  const raw = (env.ROLLEKATALOG_URL ?? '').trim();
  if (!raw) throw new Usage('ROLLEKATALOG_URL mangler.');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Usage('ROLLEKATALOG_URL er ikke en gyldig URL.');
  }
  if (u.username || u.password) throw new Usage('ROLLEKATALOG_URL må ikke indeholde brugernavn eller adgangskode.');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Usage('ROLLEKATALOG_URL skal være https://.');
  if (u.protocol === 'http:' && !isLoopback(u.hostname) && env.ROLLEKATALOG_ALLOW_HTTP !== 'true') {
    throw new Usage('ROLLEKATALOG_URL skal være https:// (insecure_url). Nøglen sendes ikke i klartekst.');
  }
  const key = (env.ROLLEKATALOG_ITSYSTEM_API_KEY ?? '').trim();
  if (!key) throw new Usage('ROLLEKATALOG_ITSYSTEM_API_KEY mangler.');
  if (/[^\x21-\x7e]/.test(key)) throw new Usage('ROLLEKATALOG_ITSYSTEM_API_KEY indeholder ugyldige tegn.');
  const timeout = Number(env.ROLLEKATALOG_TIMEOUT_MS);
  return {
    base: u.origin + u.pathname.replace(/\/+$/, ''),
    origin: u.origin,
    key,
    timeoutMs: Number.isInteger(timeout) && timeout > 0 ? timeout : 10000,
  };
}

function loadDefinition() {
  let def;
  try {
    def = JSON.parse(readFileSync(definitionPath, 'utf8'));
  } catch {
    throw new Failure('invalid_definition', 'system-roles.json');
  }
  const ok =
    def &&
    def.itSystem &&
    typeof def.itSystem.name === 'string' &&
    typeof def.itSystem.defaultIdentifier === 'string' &&
    typeof def.orgUnitConstraintEntityId === 'string' &&
    Array.isArray(def.systemRoles) &&
    def.systemRoles.length > 0 &&
    def.systemRoles.every((r) => typeof r.identifier === 'string' && IDENTIFIER_RE.test(r.identifier) && typeof r.name === 'string');
  if (!ok) throw new Failure('invalid_definition', 'system-roles.json');
  return def;
}

function statusCode(status) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server_error';
  return 'invalid_response';
}

async function call(cfg, method, pathname, step, body) {
  const headers = { ApiKey: cfg.key, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(cfg.base + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // A redirect would re-send the ApiKey header to another host.
      redirect: 'manual',
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new Failure(timedOut ? 'timeout' : 'network', step);
  }
  if (res.status < 200 || res.status >= 300) {
    // Drain without keeping the body: it is never shown.
    await res.body?.cancel().catch(() => {});
    throw new Failure(statusCode(res.status), step, res.status);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Failure('too_large', step, res.status);
  }
  let text;
  try {
    text = await res.text();
  } catch {
    throw new Failure('network', step);
  }
  if (text.length > MAX_BYTES) throw new Failure('too_large', step, res.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new Failure('invalid_response', step, res.status);
  }
}

function sameText(a, b) {
  return (a ?? '') === (b ?? '');
}

function constraintSignature(list) {
  return (Array.isArray(list) ? list : [])
    .map((c) => `${c?.constraintType?.entityId ?? '?'}${c?.mandatory ? ' (obligatorisk)' : ''}`)
    .sort()
    .join(', ');
}

function wantedSupport(role, orgConstraint) {
  return role.supportsOrgUnitConstraint && orgConstraint
    ? [{ constraintType: orgConstraint, mandatory: role.constraintMandatory === true }]
    : [];
}

function roleDrift(role, existing, orgConstraint) {
  const drift = [];
  if (!sameText(existing.name, role.name)) drift.push(`navn: "${existing.name ?? ''}" i stedet for "${role.name}"`);
  if (!sameText(existing.description, role.description)) drift.push('beskrivelse afviger');
  if ((existing.weight ?? 1) !== role.weight) {
    drift.push(`vægt: ${existing.weight ?? 1} i stedet for ${role.weight} (roller med lavere vægt skjules af Rollekatalog)`);
  }
  const have = constraintSignature(existing.supportedConstraintTypes);
  const want = constraintSignature(wantedSupport(role, orgConstraint));
  if (have !== want) {
    drift.push(
      `afgrænsninger: "${have || 'ingen'}" i stedet for "${want || 'ingen'}" (kan ikke ændres via API; ret i Rollekatalog eller slet og opret rollen igen)`,
    );
  }
  return drift;
}

function systemDrift(def, existing, name) {
  const drift = [];
  if (!sameText(existing.name, name)) drift.push(`navn: "${existing.name ?? ''}" i stedet for "${name}"`);
  if (existing.systemtype !== def.itSystem.systemtype) {
    drift.push(`type: ${existing.systemtype} i stedet for ${def.itSystem.systemtype}`);
  }
  if (existing.accesBlocked === true) drift.push('adgang er blokeret (accesBlocked): Rollekatalog udleverer ingen roller');
  return drift;
}

async function run(argv, env, out) {
  const opts = parseArgs(argv);
  if (opts.help) {
    out('Brug: node scripts/rollekatalog-register.mjs [--apply]');
    out('Uden --apply vises kun en plan. Se kommentaren øverst i scriptet for miljøvariabler.');
    return EXIT_OK;
  }
  const cfg = readConfig(env);
  const def = loadDefinition();
  const identifier = (env.ROLLEKATALOG_ITSYSTEM_ID ?? '').trim() || def.itSystem.defaultIdentifier;
  if (!IDENTIFIER_RE.test(identifier)) throw new Usage('ROLLEKATALOG_ITSYSTEM_ID må kun indeholde A-Z, a-z, 0-9, _ og -.');
  const systemName = (env.ROLLEKATALOG_ITSYSTEM_NAME ?? '').trim() || def.itSystem.name;

  out(`Rollekatalog-registrering (${opts.apply ? 'apply' : 'dry-run: intet skrives'})`);
  out(`Rollekatalog: ${cfg.origin}`);
  out(`IT-system: ${identifier}`);

  const counts = { created: 0, existing: 0, drift: 0 };
  const verbCreate = opts.apply ? 'oprettet' : 'ville oprette';

  // Every call below uses the same ITSYSTEM key; a wrong key stops at the first one.
  const systems = await call(cfg, 'GET', '/api/v2/itsystem', 'hent it-systemer');
  if (!Array.isArray(systems)) throw new Failure('invalid_response', 'hent it-systemer');
  const matches = systems.filter((s) => s && s.identifier === identifier);
  if (matches.length > 1) {
    throw new Failure('ambiguous_itsystem', 'find it-system');
  }
  let system = matches[0] ?? null;

  const needsConstraint = def.systemRoles.some((r) => r.supportsOrgUnitConstraint);
  let orgConstraint = null;
  if (needsConstraint) {
    const types = await call(cfg, 'GET', '/api/v2/constraint', 'hent afgrænsningstyper');
    if (!Array.isArray(types)) throw new Failure('invalid_response', 'hent afgrænsningstyper');
    orgConstraint = types.find((t) => t && t.entityId === def.orgUnitConstraintEntityId) ?? null;
    if (!orgConstraint || typeof orgConstraint.id !== 'number') throw new Failure('constraint_type_missing', 'find enhedsafgrænsning');
  }

  if (system) {
    const drift = systemDrift(def, system, systemName);
    if (drift.length === 0) {
      out('[findes] IT-system');
      counts.existing += 1;
    } else {
      out('[afvigelse] IT-system (ændres ikke)');
      for (const d of drift) out(`    - ${d}`);
      counts.drift += 1;
    }
  } else {
    out(`[${verbCreate}] IT-system "${systemName}" (${def.itSystem.systemtype})`);
    counts.created += 1;
    if (opts.apply) {
      // Everything not sent keeps the Rollekatalog default (false). The app never assigns roles through the API.
      const created = await call(cfg, 'POST', '/api/v2/itsystem', 'opret it-system', {
        name: systemName,
        identifier,
        systemtype: def.itSystem.systemtype,
        paused: false,
        hidden: false,
        readonly: false,
        canEditThroughApi: false,
        deleted: false,
        accesBlocked: false,
        apiManagedRoleAssignments: false,
      });
      if (!created || typeof created.id !== 'number') throw new Failure('invalid_response', 'opret it-system');
      system = created;
    }
  }

  let existingRoles = [];
  if (system) {
    const list = await call(cfg, 'GET', `/api/v2/itsystem/${system.id}/systemroles`, 'hent systemroller');
    if (!Array.isArray(list)) throw new Failure('invalid_response', 'hent systemroller');
    existingRoles = list;
  }

  for (const role of def.systemRoles) {
    const found = existingRoles.filter((r) => r && r.identifier === role.identifier);
    if (found.length > 1) throw new Failure('ambiguous_role', `find rolle ${role.identifier}`);
    if (found.length === 1) {
      const drift = roleDrift(role, found[0], orgConstraint);
      if (drift.length === 0) {
        out(`[findes] ${role.identifier}`);
        counts.existing += 1;
      } else {
        out(`[afvigelse] ${role.identifier} (ændres ikke)`);
        for (const d of drift) out(`    - ${d}`);
        counts.drift += 1;
      }
      continue;
    }
    const suffix = role.supportsOrgUnitConstraint ? ', understøtter enhedsafgrænsning' : '';
    out(`[${verbCreate}] ${role.identifier} "${role.name}"${suffix}`);
    counts.created += 1;
    if (opts.apply) {
      await call(cfg, 'POST', `/api/v2/itsystem/${system.id}/systemroles`, `opret rolle ${role.identifier}`, {
        name: role.name,
        identifier: role.identifier,
        description: role.description,
        weight: role.weight,
        supportedConstraintTypes: wantedSupport(role, orgConstraint),
      });
    }
  }

  out(`Resumé: ${opts.apply ? 'oprettet' : 'ville oprette'}=${counts.created}, findes=${counts.existing}, afvigelser=${counts.drift}`);
  if (!opts.apply && counts.created > 0) out('Intet er skrevet. Kør igen med --apply for at oprette.');
  if (counts.drift > 0) out('Afvigelser er kun rapporteret; ret dem manuelt i Rollekatalog.');
  if (counts.created > 0 && opts.apply) {
    out('Næste skridt i Rollekatalog: opret en jobfunktionsrolle for hver systemrolle og tildel den efter enhed/titel.');
  }
  return EXIT_OK;
}

async function main() {
  const out = (line) => process.stdout.write(`${line}\n`);
  try {
    process.exitCode = await run(process.argv.slice(2), process.env, out);
  } catch (err) {
    if (err instanceof Usage) {
      process.stderr.write(`Fejl: ${err.message}\n`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    if (err instanceof Failure) {
      // Only a short code, the step and the HTTP status: never the key, a URL with credentials or a response body.
      const status = err.status ? ` (HTTP ${err.status})` : '';
      process.stderr.write(`Fejl: ${err.code}${status} ved "${err.step}".\n`);
      if (err.code === 'unauthorized') process.stderr.write('Tjek ROLLEKATALOG_ITSYSTEM_API_KEY.\n');
      if (err.code === 'forbidden') process.stderr.write('API-klienten skal have rollen ITSYSTEM.\n');
      process.exitCode = EXIT_FAIL;
      return;
    }
    process.stderr.write('Fejl: unexpected\n');
    process.exitCode = EXIT_FAIL;
  }
}

await main();

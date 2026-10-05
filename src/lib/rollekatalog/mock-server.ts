// In-process mock of the OS2rollekatalog API, for tests (and, via
// scripts/mock-rollekatalog.mjs, local development). It emulates the behaviour
// verified from the 2026r4 source (docs/central-access/phase0-findings.md), not an
// idealised API:
//   - auth is the `ApiKey` header; missing/unknown key = 401
//   - the READ key is refused (403) on /api/organisation/v3 and /api/v2/manager;
//     the ORG key is refused (403) on the read endpoints (ORGANISATION does not imply READ_ACCESS)
//   - rolesAsList: 404 with an EMPTY body for an unknown user/system/domain; a disabled
//     user still gets 200 with disabled:true and their roles (not blanked)
//   - roleAssignmentsWithContraints: unknown system = 404 with body []
//   - organisation v3 returns ONLY users with at least one position, and the user DTO
//     still carries cpr/nemloginUuid/phone (fake values) so tests can prove they are dropped
// Never use against production code paths other than tests; the keys are public constants.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export const MOCK_READ_KEY = 'mock-read-key-0000';
export const MOCK_ORG_KEY = 'mock-org-key-0000';
export const MOCK_ITSYSTEM = 'os2taletiltekst';
/** ITSYSTEM client key, only for the registration script (POST /api/v2/itsystem...). */
export const MOCK_ITSYSTEM_KEY = 'mock-itsystem-key-0000';
export const MOCK_DOMAIN = 'Administrativt';

export type MockKeyRole = 'read' | 'org' | 'itsystem' | 'none' | 'unknown';

export interface RecordedRequest {
  method: string;
  /** Pathname only. */
  path: string;
  /** Raw query string without the leading '?'. */
  query: string;
  /** Which key the caller presented. The key itself is never recorded. */
  keyRole: MockKeyRole;
  status: number;
}

interface MockOrgUser {
  uuid: string;
  extUuid: string | null;
  userId: string;
  name: string;
  email: string | null;
  disabled: boolean;
  positions: Array<{ orgUnitUuid: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface MockData {
  /** Every user Rollekatalog knows; organisation v3 only returns those with >= 1 position. */
  users: MockOrgUser[];
  orgUnits: unknown[];
  managers: unknown[];
  /** Body of roleAssignmentsWithContraints (an array). */
  roleAssignments: unknown[];
  constraints: unknown[];
  /**
   * Per-user rolesAsList override keyed by lower-case userId: a body, or null for 404.
   * Without an override the body is derived from users + roleAssignments.
   */
  rolesAsList: Record<string, unknown | null>;
}

/** State behind the registration endpoints (/api/v2/itsystem...), keyed by numeric it-system id. */
export interface MockRegistry {
  itSystems: Array<Record<string, unknown> & { id: number; identifier: string }>;
  systemRoles: Record<string, Array<Record<string, unknown> & { id: number; identifier: string }>>;
  nextId: number;
}

export interface MockFault {
  /** Matches the request pathname (a string = prefix match). */
  match: string | RegExp;
  /** Wait this long before answering (for timeout tests). */
  delayMs?: number;
  /** Answer with this status and an empty body instead of the real response. */
  status?: number;
  /** Answer 200 with a body larger than this many bytes. `chunked` omits Content-Length. */
  oversize?: { bytes: number; chunked?: boolean };
  /** Answer 200 with a body that is not JSON. */
  invalidJson?: boolean;
  /** Apply to the first N matching requests only (default: all). */
  times?: number;
}

export interface MockOptions {
  readKey?: string;
  orgKey?: string;
  /** Key of the ITSYSTEM client; default MOCK_ITSYSTEM_KEY. */
  itSystemKey?: string;
  itSystem?: string;
  /** Domains Rollekatalog knows. A `domain` query value outside this list gives 404. Default ['Administrativt']. */
  domains?: string[];
  data?: Partial<MockData>;
  faults?: MockFault[];
}

export interface MockRollekatalog {
  /** http://127.0.0.1:<port> (loopback, so the client's https rule allows it). */
  url: string;
  readKey: string;
  orgKey: string;
  itSystemKey: string;
  /** Live registration state (it-systems and system roles created through the ITSYSTEM key). */
  registry: MockRegistry;
  /** Replace the registration state, e.g. to preload a drifted it-system. */
  setRegistry(next: Partial<MockRegistry>): void;
  close(): Promise<void>;
  /** Replace parts of the served data. */
  setData(partial: Partial<MockData>): void;
  /** Back to the fixtures. */
  resetData(): void;
  setFaults(faults: MockFault[]): void;
  /** Live list: every request in arrival order. */
  requests: RecordedRequest[];
  clearRequests(): void;
}

const FIXTURE_DIR = path.join(__dirname, '__fixtures__');
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));

/** A fresh deep copy of the fixture data. */
export function fixtureData(): MockData {
  const org = fixture('organisation-v3.json') as { users: MockOrgUser[]; orgUnits: unknown[] };
  return {
    users: org.users,
    orgUnits: org.orgUnits,
    managers: fixture('managers-v2.json') as unknown[],
    roleAssignments: fixture('role-assignments-with-constraints.json') as unknown[],
    constraints: fixture('constraints-v2.json') as unknown[],
    rolesAsList: {},
  };
}

interface UserAssignmentsLike {
  extUuid?: string | null;
  userId?: string | null;
  assignments?: Array<{ roleIdentifier: string }>;
}

function matches(fault: MockFault, pathname: string): boolean {
  return typeof fault.match === 'string' ? pathname.startsWith(fault.match) : fault.match.test(pathname);
}

export async function startMockRollekatalog(options: MockOptions = {}): Promise<MockRollekatalog> {
  const readKey = options.readKey ?? MOCK_READ_KEY;
  const orgKey = options.orgKey ?? MOCK_ORG_KEY;
  const itSystemKey = options.itSystemKey ?? MOCK_ITSYSTEM_KEY;
  const itSystem = options.itSystem ?? MOCK_ITSYSTEM;
  const domains = options.domains ?? [MOCK_DOMAIN];
  let data: MockData = { ...fixtureData(), ...options.data };
  let faults = (options.faults ?? []).map((f) => ({ ...f, remaining: f.times ?? Infinity }));
  const requests: RecordedRequest[] = [];
  let registry: MockRegistry = { itSystems: [], systemRoles: {}, nextId: 1 };

  // Emulates ItSystemApiV2 (2026r4) for the endpoints the registration script uses.
  // The real failure mode for an unknown constraint type id is unverified; the mock answers 400.
  async function registryServe(
    req: http.IncomingMessage,
    pathname: string,
    finish: (status: number, keyRole: MockKeyRole, body?: unknown) => void,
  ) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Record<string, unknown> | null = null;
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return finish(400, 'itsystem');
      }
    }
    const method = req.method ?? '';
    if (pathname === '/api/v2/itsystem') {
      if (method === 'GET') return finish(200, 'itsystem', registry.itSystems);
      if (method === 'POST') {
        if (!body || !['AD', 'SAML', 'MANUAL'].includes(String(body.systemtype))) return finish(400, 'itsystem');
        if (body.systemtype === 'AD') return finish(400, 'itsystem');
        const created = {
          id: registry.nextId++,
          name: body.name ?? null,
          identifier: String(body.identifier ?? ''),
          systemtype: body.systemtype,
          paused: body.paused === true,
          hidden: body.hidden === true,
          readonly: body.readonly === true,
          canEditThroughApi: body.canEditThroughApi === true,
          deleted: body.deleted === true,
          accesBlocked: body.accesBlocked === true,
          apiManagedRoleAssignments: body.apiManagedRoleAssignments === true,
          domain: null,
          email: body.email ?? null,
          attestationResponsibleUuids: [],
          systemOwnerUuids: [],
        };
        registry.itSystems.push(created);
        return finish(200, 'itsystem', created);
      }
      return finish(405, 'itsystem');
    }
    const m = /^\/api\/v2\/itsystem\/(\d+)\/systemroles$/.exec(pathname);
    if (!m) return finish(404, 'itsystem');
    const sys = registry.itSystems.find((s) => String(s.id) === m[1]);
    if (!sys) return finish(404, 'itsystem');
    const roles = (registry.systemRoles[m[1]] ??= []);
    if (method === 'GET') return finish(200, 'itsystem', roles);
    if (method === 'POST') {
      if (!body || typeof body.name !== 'string' || !body.name || typeof body.identifier !== 'string' || !body.identifier) {
        return finish(400, 'itsystem');
      }
      const supported: unknown[] = [];
      for (const raw of (Array.isArray(body.supportedConstraintTypes) ? body.supportedConstraintTypes : []) as Array<{
        constraintType?: { id?: number };
        mandatory?: boolean;
      }>) {
        const known = (data.constraints as Array<{ id: number }>).find((c) => c.id === raw.constraintType?.id);
        if (!known) return finish(400, 'itsystem');
        supported.push({ constraintType: known, mandatory: raw.mandatory === true });
      }
      const created = {
        id: registry.nextId++,
        name: body.name,
        identifier: body.identifier,
        description: body.description ?? null,
        weight: typeof body.weight === 'number' ? body.weight : 1,
        supportedConstraintTypes: supported,
      };
      roles.push(created);
      return finish(201, 'itsystem', created);
    }
    return finish(405, 'itsystem');
  }

  function rolesAsListFor(userParam: string): { status: number; body?: unknown } {
    const needle = userParam.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(data.rolesAsList, needle)) {
      const override = data.rolesAsList[needle];
      return override === null ? { status: 404 } : { status: 200, body: override };
    }
    const user =
      data.users.find((u) => u.userId?.toLowerCase() === needle) ??
      data.users.find((u) => (u.extUuid ?? '').toLowerCase() === needle);
    if (!user) return { status: 404 };
    const mine = (data.roleAssignments as UserAssignmentsLike[]).filter(
      (a) => (a.userId ?? '').toLowerCase() === user.userId.toLowerCase() || (a.extUuid && a.extUuid === user.extUuid),
    );
    const identifiers = [...new Set(mine.flatMap((a) => (a.assignments ?? []).map((x) => x.roleIdentifier)))];
    return {
      status: 200,
      body: {
        nameID: `C=DK,O=00000000,CN=${user.name},Serial=${user.extUuid ?? ''}`,
        userRoles: identifiers.map((i) => `${i}-rolle`),
        systemRoles: identifiers,
        dataRoles: [],
        functionRoles: [],
        roleMap: Object.fromEntries(identifiers.map((i) => [`${i}-rolle`, `${i} (Mock)`])),
        // Roles are deliberately NOT blanked for a disabled user (verified behaviour).
        disabled: user.disabled === true,
      },
    };
  }

  const server = http.createServer((req, res) => {
    const finish = (status: number, keyRole: MockKeyRole, body?: unknown, raw?: string) => {
      requests.push({ method: req.method ?? '', path: pathname, query: search, keyRole, status });
      if (raw !== undefined) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(raw);
      } else if (body === undefined) {
        res.writeHead(status);
        res.end();
      } else {
        const json = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
        res.end(json);
      }
    };

    const url = new URL(req.url ?? '/', 'http://mock.invalid');
    const pathname = url.pathname;
    const search = url.search.replace(/^\?/, '');

    // Auth: ONLY the ApiKey header counts. Authorization is ignored, like the real filter.
    const presented = req.headers['apikey'];
    const key = Array.isArray(presented) ? presented[0] : presented;
    if (!key) return finish(401, 'none');
    const keyRole: MockKeyRole =
      key === readKey ? 'read' : key === orgKey ? 'org' : key === itSystemKey ? 'itsystem' : 'unknown';
    if (keyRole === 'unknown') return finish(401, keyRole);
    // ITSYSTEM = READ_ACCESS + ITSYSTEM (ApiSecurityFilter): registration endpoints plus the read endpoints.
    if (keyRole === 'itsystem' && pathname.startsWith('/api/v2/itsystem')) {
      void registryServe(req, pathname, finish);
      return;
    }
    if (req.method !== 'GET') return finish(405, keyRole);

    const orgEndpoint = pathname === '/api/organisation/v3' || pathname === '/api/v2/manager';
    const readEndpoint =
      pathname.startsWith('/api/read/') || /^\/api\/user\/[^/]+\/rolesAsList$/.test(pathname) || pathname === '/api/v2/constraint';
    if (!orgEndpoint && !readEndpoint) return finish(404, keyRole);
    if ((orgEndpoint && keyRole !== 'org') || (readEndpoint && keyRole !== 'read' && keyRole !== 'itsystem')) {
      return finish(403, keyRole);
    }

    const fault = faults.find((f) => f.remaining > 0 && matches(f, pathname));
    if (fault) {
      fault.remaining -= 1;
      const respond = () => {
        if (fault.status !== undefined) return finish(fault.status, keyRole);
        if (fault.invalidJson) return finish(200, keyRole, undefined, '{"users": [');
        if (fault.oversize) {
          requests.push({ method: 'GET', path: pathname, query: search, keyRole, status: 200 });
          const total = fault.oversize.bytes + 1024;
          if (fault.oversize.chunked) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('["');
            let sent = 2;
            const chunk = 'x'.repeat(8192);
            const pump = () => {
              while (sent < total) {
                sent += chunk.length;
                if (!res.write(chunk)) return void res.once('drain', pump);
              }
              res.end('"]');
            };
            pump();
            return;
          }
          const body = `["${'x'.repeat(total)}"]`;
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
          res.end(body);
          return;
        }
        return serve();
      };
      if (fault.delayMs) setTimeout(respond, fault.delayMs);
      else respond();
      return;
    }
    serve();

    function serve() {
      if (pathname === '/api/organisation/v3') {
        // Only users with at least one position are exported by the real exporter.
        return finish(200, keyRole, {
          users: data.users.filter((u) => Array.isArray(u.positions) && u.positions.length > 0),
          orgUnits: data.orgUnits,
        });
      }
      if (pathname === '/api/v2/manager') return finish(200, keyRole, data.managers);
      if (pathname === '/api/v2/constraint') return finish(200, keyRole, data.constraints);

      const domain = url.searchParams.get('domain');
      const domainKnown = !domain || domains.includes(domain);

      if (pathname.startsWith('/api/read/itsystem/roleAssignmentsWithContraints/')) {
        const system = decodeURIComponent(pathname.split('/').pop() ?? '');
        if (!domainKnown) return finish(404, keyRole);
        if (system !== itSystem) return finish(404, keyRole, []);
        return finish(200, keyRole, data.roleAssignments);
      }

      const m = /^\/api\/user\/([^/]+)\/rolesAsList$/.exec(pathname);
      if (m) {
        const system = url.searchParams.get('system');
        if (!system) return finish(400, keyRole); // Spring: missing required param
        if (!domainKnown || system !== itSystem) return finish(404, keyRole);
        const r = rolesAsListFor(decodeURIComponent(m[1]));
        return r.status === 200 ? finish(200, keyRole, r.body) : finish(r.status, keyRole);
      }
      return finish(404, keyRole);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    readKey,
    orgKey,
    itSystemKey,
    get registry() {
      return registry;
    },
    setRegistry(next) {
      registry = { ...registry, ...next };
    },
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    setData(partial) {
      data = { ...data, ...partial };
    },
    resetData() {
      data = fixtureData();
      registry = { itSystems: [], systemRoles: {}, nextId: 1 };
    },
    setFaults(next) {
      faults = next.map((f) => ({ ...f, remaining: f.times ?? Infinity }));
    },
    clearRequests() {
      requests.length = 0;
    },
  };
}

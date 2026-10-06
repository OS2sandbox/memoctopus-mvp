// In-process mock of the OS2rollekatalog API, for tests. It emulates the behaviour
// read from the 2026r4 source, not an idealised API:
//   - auth is the `ApiKey` header; missing/unknown key = 401
//   - the READ key is refused (403) on /api/organisation/v3; the ORG key is refused
//     (403) on the read endpoints (ORGANISATION does not imply READ_ACCESS)
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
export const MOCK_DOMAIN = 'Administrativt';

export type MockKeyRole = 'read' | 'org' | 'none' | 'unknown';

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
  /** Body of roleAssignmentsWithContraints (an array). */
  roleAssignments: unknown[];
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
    roleAssignments: fixture('role-assignments-with-constraints.json') as unknown[],
  };
}

function matches(fault: MockFault, pathname: string): boolean {
  return typeof fault.match === 'string' ? pathname.startsWith(fault.match) : fault.match.test(pathname);
}

export async function startMockRollekatalog(options: MockOptions = {}): Promise<MockRollekatalog> {
  const readKey = options.readKey ?? MOCK_READ_KEY;
  const orgKey = options.orgKey ?? MOCK_ORG_KEY;
  const itSystem = options.itSystem ?? MOCK_ITSYSTEM;
  const domains = options.domains ?? [MOCK_DOMAIN];
  let data: MockData = { ...fixtureData(), ...options.data };
  let faults = (options.faults ?? []).map((f) => ({ ...f, remaining: f.times ?? Infinity }));
  const requests: RecordedRequest[] = [];

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
    const keyRole: MockKeyRole = key === readKey ? 'read' : key === orgKey ? 'org' : 'unknown';
    if (keyRole === 'unknown') return finish(401, keyRole);
    if (req.method !== 'GET') return finish(405, keyRole);

    const orgEndpoint = pathname === '/api/organisation/v3';
    const readEndpoint = pathname.startsWith('/api/read/');
    if (!orgEndpoint && !readEndpoint) return finish(404, keyRole);
    if ((orgEndpoint && keyRole !== 'org') || (readEndpoint && keyRole !== 'read')) return finish(403, keyRole);

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

      const domain = url.searchParams.get('domain');
      const domainKnown = !domain || domains.includes(domain);

      if (pathname.startsWith('/api/read/itsystem/roleAssignmentsWithContraints/')) {
        const system = decodeURIComponent(pathname.split('/').pop() ?? '');
        if (!domainKnown) return finish(404, keyRole);
        if (system !== itSystem) return finish(404, keyRole, []);
        return finish(200, keyRole, data.roleAssignments);
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
    },
    setFaults(next) {
      faults = next.map((f) => ({ ...f, remaining: f.times ?? Infinity }));
    },
    clearRequests() {
      requests.length = 0;
    },
  };
}

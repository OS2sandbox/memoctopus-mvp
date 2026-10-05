// "Test forbindelse": calls every Rollekatalog endpoint the app uses ONCE with the
// configured keys and reports, per endpoint, whether it answered and whether the
// answer matched our schema. The report is safe to show an operator: only HTTP
// status, short error codes, counts and booleans. Never a name, an id, a key, a URL
// or any other value from the response.
import { ROLE_KEYS } from '@/lib/authz/types';
import { maxResponseBytes, rollekatalogConfigIssue, type RollekatalogConfigIssue } from './config';
import { createRollekatalogClient, type ClientOptions } from './client';
import { errorCodeOf } from './errors';
import { isOrgUnitConstraintType } from './types';

export const CHECK_ENDPOINTS = ['organisation', 'managers', 'roleAssignments', 'constraints', 'rolesAsList'] as const;
export type CheckEndpoint = (typeof CHECK_ENDPOINTS)[number];

export interface EndpointCheck {
  endpoint: CheckEndpoint;
  ok: boolean;
  /** The HTTP status when the server answered; null when it did not (network, timeout, not configured). */
  httpStatusCode: number | null;
  /** True only when the body was parsed by our whitelist schema. */
  schemaValid: boolean;
  counts?: Record<string, number>;
  /**
   * True when the raw response carried a field named like cpr or nemlogin. Our schemas
   * strip such fields, so this tells an operator that Rollekatalog sends them and that
   * the app drops them; it is never an error.
   */
  cprFieldPresentInResponse?: boolean;
  errorCode?: string;
  /** The endpoint was not called (rolesAsList needs a user id). */
  skipped?: boolean;
}

export interface CheckReport {
  configured: boolean;
  configIssue: RollekatalogConfigIssue | null;
  endpoints: EndpointCheck[];
}

export interface CheckOptions extends ClientOptions {
  /** The Rollekatalog user id for the rolesAsList probe (the admin's own); null/absent skips it. */
  rolesAsListUserId?: string | null;
}

const SENSITIVE_KEY = /cpr|nemlogin/i;

/** Iterative walk (a hostile body could be deeply nested); stops at the first sensitive key. */
function hasSensitiveKey(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (typeof node === 'object' && node !== null) {
      for (const [k, v] of Object.entries(node)) {
        if (SENSITIVE_KEY.test(k)) return true;
        stack.push(v);
      }
    }
  }
  return false;
}

/** Reads at most maxBytes of a cloned body; null when it is larger or unreadable. */
async function readBounded(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface Probe {
  fetch: typeof fetch;
  status: () => number | null;
  sensitive: () => boolean | undefined;
}

// The client parses with a whitelist, so the raw body is only visible at the fetch
// seam. A clone is inspected for key NAMES only; nothing from it is kept.
function probe(base: typeof fetch, maxBytes: number): Probe {
  let status: number | null = null;
  let sensitive: boolean | undefined;
  return {
    fetch: async (input, init) => {
      const res = await base(input, init);
      status = res.status;
      if (res.status >= 200 && res.status < 300) {
        try {
          const text = await readBounded(res.clone(), maxBytes);
          if (text !== null) sensitive = hasSensitiveKey(JSON.parse(text));
        } catch {
          // Not JSON or unreadable: the client reports it as invalid_response.
        }
      }
      return res;
    },
    status: () => status,
    sensitive: () => sensitive,
  };
}

const OUR_ROLES: ReadonlySet<string> = new Set(ROLE_KEYS);
const isOurRole = (identifier: string) => OUR_ROLES.has(identifier.trim().toLowerCase());

async function checkOne(
  endpoint: CheckEndpoint,
  opts: CheckOptions,
  run: (client: ReturnType<typeof createRollekatalogClient>) => Promise<Record<string, number>>,
): Promise<EndpointCheck> {
  const p = probe(opts.fetch ?? fetch, opts.maxBytes ?? maxResponseBytes());
  // One call per endpoint: the check must not hammer the heavy organisation endpoint.
  const client = createRollekatalogClient({ ...opts, fetch: p.fetch, retries: 0 });
  try {
    const counts = await run(client);
    return {
      endpoint,
      ok: true,
      httpStatusCode: p.status(),
      schemaValid: true,
      counts,
      ...(p.sensitive() !== undefined ? { cprFieldPresentInResponse: p.sensitive() } : {}),
    };
  } catch (err) {
    return {
      endpoint,
      ok: false,
      httpStatusCode: p.status(),
      schemaValid: false,
      errorCode: errorCodeOf(err),
      ...(p.sensitive() !== undefined ? { cprFieldPresentInResponse: p.sensitive() } : {}),
    };
  }
}

export async function runRollekatalogCheck(opts: CheckOptions = {}): Promise<CheckReport> {
  const issue = opts.baseUrl === undefined ? rollekatalogConfigIssue() : null;
  const endpoints: EndpointCheck[] = [];

  endpoints.push(
    await checkOne('organisation', opts, async (c) => {
      const org = await c.getOrganisation();
      return { usersSeen: org.users.length, orgUnitsSeen: org.orgUnits.length };
    }),
  );
  endpoints.push(
    await checkOne('managers', opts, async (c) => {
      const managers = await c.getManagers();
      return {
        managersSeen: managers.length,
        substitutesSeen: managers.reduce((n, m) => n + m.managerSubstitutes.length, 0),
      };
    }),
  );
  endpoints.push(
    await checkOne('roleAssignments', opts, async (c) => {
      const rows = await c.getRoleAssignments();
      const all = rows.flatMap((r) => r.assignments);
      return {
        usersSeen: rows.length,
        assignmentsSeen: all.length,
        ourRolesSeen: all.filter((a) => isOurRole(a.roleIdentifier)).length,
        assignmentsWithOrgUnitConstraint: all.filter((a) =>
          a.roleConstraintValues.some((v) => isOrgUnitConstraintType(v.constraintType) && v.constraintValues.length > 0),
        ).length,
      };
    }),
  );
  endpoints.push(
    await checkOne('constraints', opts, async (c) => {
      const types = await c.getConstraints();
      return {
        constraintTypesSeen: types.length,
        orgUnitConstraintTypesSeen: types.filter((t) => isOrgUnitConstraintType(t.entityId)).length,
      };
    }),
  );

  const userId = opts.rolesAsListUserId?.trim();
  if (userId) {
    endpoints.push(
      await checkOne('rolesAsList', opts, async (c) => {
        const r = await c.getRolesAsList(userId);
        const identifiers = new Set([...r.systemRoles, ...r.userRoles, ...r.functionRoles]);
        return { ourRolesSeen: [...identifiers].filter(isOurRole).length };
      }),
    );
  } else {
    endpoints.push({ endpoint: 'rolesAsList', ok: false, httpStatusCode: null, schemaValid: false, skipped: true });
  }

  return { configured: issue === null, configIssue: issue, endpoints };
}

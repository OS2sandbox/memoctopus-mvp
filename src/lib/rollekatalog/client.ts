// Read-only HTTP client for OS2rollekatalog. GET only (the app never calls the
// write/assign endpoints), auth via the `ApiKey` header (never Authorization),
// never logs anything, and every failure is a RollekatalogError carrying a short
// code: no URL query, header, key or body can leak through an error.
import {
  itSystemId as configuredItSystemId,
  maxResponseBytes,
  orgKey as configuredOrgKey,
  readKey as configuredReadKey,
  roleGroupsPath as configuredRoleGroupsPath,
  rolesPath as configuredRolesPath,
  rollekatalogDomain,
  rollekatalogUrl,
  timeoutMs as configuredTimeoutMs,
  validateRollekatalogUrl,
} from './config';
import { RollekatalogError } from './errors';
import {
  organisationSchema,
  parseOrThrow,
  roleAssignmentsSchema,
  roleGroupsCatalogueSchema,
  userRolesCatalogueSchema,
  type RkCatalogue,
  type RkOrganisation,
  type RkRoleAssignments,
} from './schemas';

export const API_KEY_HEADER = 'ApiKey';
/** Retries after the first attempt (network, 5xx and 429 only; a timeout is never retried). */
export const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 250;

export interface ClientOptions {
  /** Test seam: replaces global fetch. */
  fetch?: typeof fetch;
  /** Test seam: replaces ROLLEKATALOG_URL (still validated: https rule applies). */
  baseUrl?: string;
  /** Test seam: replace the env keys. null forces "unset". */
  readKey?: string | null;
  orgKey?: string | null;
  itSystemId?: string;
  domain?: string | null;
  /** Test seam: replace ROLLEKATALOG_ROLES_PATH / ROLLEKATALOG_ROLEGROUPS_PATH. null = that list is not read. */
  rolesPath?: string | null;
  roleGroupsPath?: string | null;
  /** Deadline for ONE attempt, response body included. Default ROLLEKATALOG_TIMEOUT_MS (2 min). */
  timeoutMs?: number;
  maxBytes?: number;
  /** Retries after the first attempt, at most MAX_RETRIES. */
  retries?: number;
  /** Base for the exponential backoff between attempts. */
  backoffMs?: number;
  /** Test seam: replaces the real sleep. */
  sleep?: (ms: number) => Promise<void>;
}

type KeyKind = 'read' | 'org';

interface RequestSpec {
  path: string;
  query?: Record<string, string | null | undefined>;
  key: KeyKind;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function statusToError(status: number): RollekatalogError {
  if (status === 401) return new RollekatalogError('unauthorized', status);
  if (status === 403) return new RollekatalogError('forbidden', status);
  if (status === 404) return new RollekatalogError('not_found', status);
  // 429 is retried like a 5xx: the server asked us to slow down, not to give up.
  if (status >= 500 || status === 429) return new RollekatalogError('server_error', status);
  // Other 4xx and any redirect: not something retrying would fix. Redirects are
  // not followed, because a custom header such as ApiKey would be re-sent to the target.
  return new RollekatalogError('invalid_response', status);
}

// 'timeout' is deliberately absent: both calls are bulk calls (organisation v3 is a
// `synchronized` handler on the Rollekatalog side), so when our deadline passes the
// server is usually still working. A retry would only queue more load behind it.
const RETRYABLE = new Set(['network', 'server_error']);

async function readBody(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel().catch(() => {});
    throw new RollekatalogError('too_large', res.status);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new RollekatalogError('too_large', res.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class RollekatalogClient {
  constructor(private readonly opts: ClientOptions = {}) {}

  private baseUrl(): string {
    const resolved = this.opts.baseUrl !== undefined ? validateRollekatalogUrl(this.opts.baseUrl) : rollekatalogUrl();
    if (resolved.issue) throw new RollekatalogError(resolved.issue);
    return resolved.url;
  }

  private key(kind: KeyKind): string {
    const k =
      kind === 'read'
        ? this.opts.readKey !== undefined
          ? this.opts.readKey
          : configuredReadKey()
        : this.opts.orgKey !== undefined
          ? this.opts.orgKey
          : configuredOrgKey();
    if (!k) throw new RollekatalogError('not_configured');
    return k;
  }

  private system(): string {
    return this.opts.itSystemId ?? configuredItSystemId();
  }

  private domain(): string | null {
    return this.opts.domain !== undefined ? this.opts.domain : rollekatalogDomain();
  }

  // The timer is armed before fetch and cleared only after the body is read, so the
  // timeout covers the whole request including a slow body.
  private async attempt(url: string, key: string, timeoutMs: number, maxBytes: number): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const doFetch = this.opts.fetch ?? fetch;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'GET',
          headers: { [API_KEY_HEADER]: key, Accept: 'application/json' },
          redirect: 'manual',
          signal: controller.signal,
          cache: 'no-store',
        });
      } catch {
        // The fetch error can embed the host or a cause chain; only the class of failure is kept.
        throw new RollekatalogError(timedOut ? 'timeout' : 'network');
      }
      if (res.status < 200 || res.status >= 300) {
        void res.body?.cancel().catch(() => {});
        throw statusToError(res.status);
      }
      let text: string;
      try {
        text = await readBody(res, maxBytes);
      } catch (err) {
        if (err instanceof RollekatalogError) throw err;
        throw new RollekatalogError(timedOut ? 'timeout' : 'network', res.status);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new RollekatalogError('invalid_response', res.status);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(spec: RequestSpec): Promise<unknown> {
    const base = this.baseUrl();
    const key = this.key(spec.key);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(spec.query ?? {})) if (v) qs.set(k, v);
    const query = qs.toString();
    const url = `${base}${spec.path}${query ? `?${query}` : ''}`;
    const timeoutMs = this.opts.timeoutMs ?? configuredTimeoutMs();
    const maxBytes = this.opts.maxBytes ?? maxResponseBytes();
    const retries = Math.min(Math.max(this.opts.retries ?? MAX_RETRIES, 0), MAX_RETRIES);
    const backoff = this.opts.backoffMs ?? BASE_BACKOFF_MS;
    const sleep = this.opts.sleep ?? realSleep;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(url, key, timeoutMs, maxBytes);
      } catch (err) {
        const retryable = err instanceof RollekatalogError && RETRYABLE.has(err.code);
        if (!retryable || attempt >= retries) throw err;
        await sleep(backoff * 2 ** attempt);
      }
    }
  }

  /** ORG key. Heavy, synchronized on the Rollekatalog side: call it only from the sync. */
  async getOrganisation(): Promise<RkOrganisation> {
    return parseOrThrow(organisationSchema, await this.request({ path: '/api/organisation/v3', key: 'org' }));
  }

  /** READ key. Effective assignments with resolved constraint values for our IT system. */
  async getRoleAssignments(): Promise<RkRoleAssignments> {
    const data = await this.request({
      path: `/api/read/itsystem/roleAssignmentsWithContraints/${encodeURIComponent(this.system())}`,
      query: { domain: this.domain() },
      key: 'read',
    });
    return parseOrThrow(roleAssignmentsSchema, data);
  }

  /**
   * READ key. The role CATALOGUE: every user role and role group, names and identifiers only
   * (see schemas.ts). The paths are configurable and unverified against a live instance.
   */
  async getRoleCatalogue(): Promise<RkRoleCatalogue> {
    const rolesAt = this.opts.rolesPath !== undefined ? this.opts.rolesPath : configuredRolesPath();
    const groupsAt = this.opts.roleGroupsPath !== undefined ? this.opts.roleGroupsPath : configuredRoleGroupsPath();
    const empty: RkCatalogue = { entries: [], skipped: 0 };
    // Sequential: both are plain lists, but there is no reason to double the load on the server.
    const roles = rolesAt
      ? parseOrThrow(userRolesCatalogueSchema, await this.request({ path: rolesAt, key: 'read' }))
      : empty;
    const groups = groupsAt
      ? parseOrThrow(roleGroupsCatalogueSchema, await this.request({ path: groupsAt, key: 'read' }))
      : empty;
    return { roles, groups, read: { roles: Boolean(rolesAt), groups: Boolean(groupsAt) } };
  }
}

/** What the catalogue refresh reads: a list per kind, an empty one when that list is switched off. */
export interface RkRoleCatalogue {
  roles: RkCatalogue;
  groups: RkCatalogue;
  /** Which lists were actually requested (path not 'none'). Absent means both. A list that was not read says nothing about its entries. */
  read?: { roles: boolean; groups: boolean };
}

/** A client that reads URL, keys and limits from the environment at call time. */
export function createRollekatalogClient(opts: ClientOptions = {}): RollekatalogClient {
  return new RollekatalogClient(opts);
}

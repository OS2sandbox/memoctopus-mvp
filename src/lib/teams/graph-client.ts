import { auth } from '@/lib/auth';
import { GRAPH_DELEGATED_SCOPES } from '@/lib/auth/providers';

// ─── Microsoft Graph, called as the signed-in user ────────────────────────────
// Delegated auth, not application permissions: better-auth already stores the
// Entra ID `access_token` / `refresh_token` / `scope` on the `account` row, so
// every Graph call here rides on the user's own consent. That is what lets a
// customer set this up with one "Grant admin consent" click instead of the
// per-user `New-CsApplicationAccessPolicy` PowerShell dance that application
// permissions require. See docs/plans/2026-09-08-microsoft-graph-teams-integration.md §1.

/** Delegated scopes the Teams integration needs. Requested at sign-in (auth/index.ts). */
export const GRAPH_SCOPES = GRAPH_DELEGATED_SCOPES;

/** Scopes an OIDC login gives us for free — never part of a consent gap. */
const OIDC_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);

/** The scopes whose absence means the user must re-consent. */
const REQUIRED_GRAPH_SCOPES = GRAPH_SCOPES.filter((s) => !OIDC_SCOPES.has(s));

export type GraphErrorCode =
  | 'consent_required'
  | 'reauth_required'
  | 'transcripts_disabled'
  | 'not_found'
  | 'forbidden'
  | 'http';

export class GraphError extends Error {
  readonly code: GraphErrorCode;
  readonly status: number;
  readonly missingScopes?: string[];
  /**
   * True when the failure is transient (throttling, gateway, outage) and the
   * same request is worth repeating later. Graph throttles the transcript and
   * recording collections routinely, so a 429 five minutes after a meeting must
   * mean "not yet", never "this meeting will never produce a referat".
   */
  readonly retryable: boolean;
  /** `Retry-After` in milliseconds, when Graph told us how long to wait. */
  readonly retryAfterMs: number | null;

  constructor(
    code: GraphErrorCode,
    message: string,
    options: {
      status?: number;
      missingScopes?: string[];
      cause?: unknown;
      retryable?: boolean;
      retryAfterMs?: number | null;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'GraphError';
    this.code = code;
    this.status = options.status ?? 0;
    if (options.missingScopes) this.missingScopes = options.missingScopes;
    this.retryable = options.retryable ?? isRetryableStatus(this.status);
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** 408 Request Timeout, 429 Too Many Requests and every 5xx are worth retrying. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/** `Retry-After` is either delta-seconds or an HTTP date; both become ms. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const raw = header.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * Graph base URL. `||` not `??` — docker-compose passes unset variables through
 * as empty strings (same hazard documented in src/lib/ai/diarization.ts).
 */
export function graphOrigin(): string {
  return (process.env.GRAPH_BASE_URL?.trim() || 'https://graph.microsoft.com/v1.0').replace(
    /\/+$/,
    '',
  );
}

// Entra returns scopes space-delimited; better-auth persists them comma-joined.
// Values may arrive fully qualified ("https://graph.microsoft.com/Calendars.Read")
// and with arbitrary casing, so normalise both sides before comparing.
function normaliseScope(scope: string): string {
  const bare = scope.trim().replace(/^https?:\/\/[^/]+\//i, '');
  return bare.toLowerCase();
}

function parseScopes(scopes: readonly string[] | string | undefined | null): Set<string> {
  const list = Array.isArray(scopes) ? scopes : String(scopes ?? '').split(/[\s,]+/);
  return new Set(list.flatMap((s) => String(s).split(/[\s,]+/)).map(normaliseScope).filter(Boolean));
}

function missingFrom(granted: Set<string>): string[] {
  return REQUIRED_GRAPH_SCOPES.filter((s) => !granted.has(normaliseScope(s)));
}

interface TokenResult {
  accessToken: string;
  scopes: Set<string>;
}

/**
 * better-auth refreshes the access token here when it has expired (see
 * node_modules/better-auth/dist/api/routes/account.mjs → /get-access-token).
 * Any failure — no Microsoft account linked, refresh token expired or revoked —
 * comes back as an APIError, and there is nothing the server can do about it:
 * the user has to sign in with Microsoft again.
 */
async function fetchToken(userId: string): Promise<TokenResult> {
  let result: { accessToken?: string | null; scopes?: string[] } | null = null;
  try {
    result = (await auth.api.getAccessToken({
      body: { providerId: 'microsoft', userId },
    })) as { accessToken?: string | null; scopes?: string[] };
  } catch (cause) {
    throw new GraphError(
      'reauth_required',
      'Kunne ikke hente et Microsoft-token. Log ind med Microsoft igen.',
      { status: 401, cause },
    );
  }

  if (!result?.accessToken) {
    throw new GraphError(
      'reauth_required',
      'Ingen Microsoft-konto er forbundet. Log ind med Microsoft igen.',
      { status: 401 },
    );
  }

  return { accessToken: result.accessToken, scopes: parseScopes(result.scopes) };
}

/**
 * A token that is good enough to call Graph with, or a typed error explaining
 * which of the two remedies the UI should offer: re-login, or re-consent.
 */
export async function getGraphAccessToken(userId: string): Promise<string> {
  const { accessToken, scopes } = await fetchToken(userId);
  const missing = missingFrom(scopes);
  if (missing.length > 0) {
    throw new GraphError(
      'consent_required',
      `Microsoft-loginet mangler adgang til: ${missing.join(', ')}. Log ind med Microsoft igen for at give adgang.`,
      { status: 403, missingScopes: missing },
    );
  }
  return accessToken;
}

/**
 * Scope check without the "throw" — for rendering the Teams entry point as
 * enabled/disabled. Users who signed in before the Graph scopes were added keep
 * a valid token whose `scope` column simply lacks them.
 */
export async function hasGraphScopes(userId: string): Promise<{ ok: boolean; missing: string[] }> {
  const { scopes } = await fetchToken(userId);
  const missing = missingFrom(scopes);
  return { ok: missing.length === 0, missing };
}

function resolveUrl(path: string): { url: string; isGraph: boolean } {
  const base = graphOrigin();
  if (!/^https?:\/\//i.test(path)) {
    return { url: `${base}/${path.replace(/^\/+/, '')}`, isGraph: true };
  }
  // Absolute URLs happen: @odata.nextLink, and the pre-signed blob/SharePoint
  // download locations Graph 302s recording content to. Those carry their own
  // authorisation — sending our bearer to a non-Graph host would leak it.
  let isGraph = false;
  try {
    isGraph = new URL(path).origin === new URL(base).origin;
  } catch {
    isGraph = false;
  }
  return { url: path, isGraph };
}

async function errorBody(res: Response): Promise<{ text: string; innerCode?: string }> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return { text: '' };
  }
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: string; message?: string; innerError?: { code?: string } };
    };
    return {
      text: parsed.error?.message || text,
      innerCode: parsed.error?.innerError?.code || parsed.error?.code,
    };
  } catch {
    return { text };
  }
}

/**
 * One Graph call. Returns the raw Response on 2xx so callers can stream a
 * recording body straight to disk; every non-2xx becomes a typed GraphError.
 */
export async function graphFetch(
  userId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const { url, isGraph } = resolveUrl(path);
  const headers = new Headers(init.headers);
  if (isGraph) {
    const token = await getGraphAccessToken(userId);
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(url, { ...init, headers });
  if (res.ok) return res;

  const { text, innerCode } = await errorBody(res);
  const detail = text ? ` — ${text}` : '';

  if (res.status === 401) {
    throw new GraphError('reauth_required', `Microsoft afviste tokenet${detail}`, {
      status: 401,
    });
  }
  if (res.status === 403) {
    // Teams reports "transcription was never turned on for this meeting" as a
    // 403, not a 404 — a distinct, actionable case for the user.
    if (innerCode === 'GraphAccessToTranscriptsDisabled') {
      throw new GraphError(
        'transcripts_disabled',
        `Transskription er ikke slået til for dette møde${detail}`,
        { status: 403 },
      );
    }
    throw new GraphError('forbidden', `Ingen adgang til denne ressource${detail}`, { status: 403 });
  }
  if (res.status === 404) {
    throw new GraphError('not_found', `Ressourcen findes ikke${detail}`, { status: 404 });
  }
  throw new GraphError('http', `Microsoft Graph svarede ${res.status}${detail}`, {
    status: res.status,
    retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
  });
}

/** graphFetch + JSON. Paging (`@odata.nextLink`) is the caller's business. */
export async function graphJson<T>(
  userId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await graphFetch(userId, path, init);
  return (await res.json()) as T;
}

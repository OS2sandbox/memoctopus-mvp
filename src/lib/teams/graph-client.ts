import { auth } from '@/lib/auth';
import { GRAPH_DELEGATED_SCOPES, teamsGraphEnabled, teamsGraphScopes } from '@/lib/auth/providers';

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

/**
 * The scopes whose absence means the user must re-consent: the ones sign-in
 * actually requests, so transcript-only mode does not demand a recording scope
 * it never asked for.
 */
function requiredGraphScopes(): string[] {
  return teamsGraphScopes().filter((s) => !OIDC_SCOPES.has(s));
}

/** Shown wherever a Teams action reaches the server while the integration is off. */
export const TEAMS_DISABLED_MESSAGE = 'Teams-integrationen er ikke slået til.';

export type GraphErrorCode =
  | 'disabled'
  | 'consent_required'
  | 'reauth_required'
  | 'transcripts_disabled'
  | 'not_found'
  | 'forbidden'
  | 'unavailable'
  | 'http';

export class GraphError extends Error {
  readonly code: GraphErrorCode;
  readonly status: number;
  readonly missingScopes?: string[];
  /**
   * True when the failure is transient (throttling, gateway, outage, timeout)
   * and the same request is worth repeating later. Graph throttles the transcript
   * and recording collections routinely, so a 429 five minutes after a meeting
   * must mean "not yet", never "this meeting will never produce a referat".
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
    this.retryable = options.retryable ?? (code === 'unavailable' || isRetryableStatus(this.status));
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
 * How long one Graph call may take before it is abandoned as transient. Without
 * a bound only undici's own defaults apply (about 5 minutes of silence), and the
 * poller runs one meeting at a time under an advisory lock, so a single stalled
 * request would hold up every user's polling.
 *
 * The AbortSignal also covers reading the body. JSON calls are small and get the
 * short bound; transcript and recording downloads get the long one, sized for a
 * recording of several hundred MB on a slow link. Fixed on purpose: nothing
 * documents an environment override, so there is none.
 */
export const GRAPH_TIMEOUT_MS = 30_000;
export const GRAPH_DOWNLOAD_TIMEOUT_MS = 20 * 60_000;

/**
 * A throttled call (429/503 with `Retry-After`) is repeated in place at most this
 * many times, and never by waiting longer than the budget in total. A longer
 * wait is not ours to sit through: it is raised as `unavailable` carrying
 * `retryAfterMs`, and the poller tries again on its next pass.
 */
const RETRY_AFTER_MAX_RETRIES = 2;
const RETRY_AFTER_BUDGET_MS = 30_000;

const UNAVAILABLE_MESSAGE = 'Microsoft er midlertidigt utilgængelig. Prøv igen om lidt.';
const TIMEOUT_MESSAGE = 'Microsoft svarede ikke i tide. Prøv igen om lidt.';

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
// Values may arrive fully qualified ("https://graph.microsoft.com/OnlineMeetings.ReadWrite")
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
  return requiredGraphScopes().filter((s) => !granted.has(normaliseScope(s)));
}

interface TokenResult {
  accessToken: string;
  scopes: Set<string>;
}

function isAbortError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** Rejects with `unavailable` if `promise` has not settled after `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new GraphError('unavailable', TIMEOUT_MESSAGE)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * What a failed better-auth token call means. better-auth's /get-access-token and
 * /refresh-token wrap the whole refresh in a try/catch that throws a fresh APIError
 * and drops the cause (verified against better-auth 1.6.11 with a stubbed token
 * endpoint): an Entra `invalid_grant`, a 429, a 503, a timeout and a network error
 * all leave as the same `{ body: { code: 'FAILED_TO_GET_ACCESS_TOKEN' } }`. So an
 * APIError cannot be told transient from permanent, and stays `reauth_required` — a
 * revoked or expired refresh token is the case a retry cannot fix and the one users
 * hit most. Anything that is NOT an APIError never went through that catch (the
 * database read before it, for one) and is not the user's sign-in at fault.
 */
function tokenFailure(cause: unknown): GraphError {
  const code = (cause as { body?: { code?: unknown } } | null)?.body?.code;
  if (typeof code === 'string') {
    return new GraphError(
      'reauth_required',
      'Kunne ikke hente et Microsoft-token. Log ind med Microsoft igen.',
      { status: 401, cause },
    );
  }
  return new GraphError('unavailable', UNAVAILABLE_MESSAGE, { cause });
}

// One in-flight token call per user, shared by everyone who asks meanwhile.
// better-auth has no lock: two concurrent calls on an expired token would each
// refresh, and the last write wins the stored refresh token (Entra rotates it, so
// the loser's is dead). resolveJoinUrl, getMeeting and listArtifacts all fan out
// several Graph calls at once, so this is the normal case. The entry lives only
// while the call is pending — a failure is never remembered.
const tokenFlights = new Map<string, Promise<TokenResult>>();
const refreshFlights = new Map<string, Promise<string>>();

function singleFlight<T>(flights: Map<string, Promise<T>>, userId: string, start: () => Promise<T>) {
  const existing = flights.get(userId);
  if (existing) return existing;
  const flight = withTimeout(start(), GRAPH_TIMEOUT_MS).finally(() => flights.delete(userId));
  flights.set(userId, flight);
  return flight;
}

/**
 * better-auth refreshes the access token here when it has expired (see
 * node_modules/better-auth/dist/api/routes/account.mjs → /get-access-token).
 * See {@link tokenFailure} for how its failures are read.
 */
async function fetchToken(userId: string): Promise<TokenResult> {
  // Nothing here can succeed while TEAMS_GRAPH_ENABLED is off: the scopes were
  // never requested. Say so, rather than let it surface as a consent gap that a
  // fresh sign-in cannot close.
  if (!teamsGraphEnabled()) {
    throw new GraphError('disabled', TEAMS_DISABLED_MESSAGE, { status: 403 });
  }

  return singleFlight(tokenFlights, userId, async () => {
    let result: { accessToken?: string | null; scopes?: string[] } | null = null;
    try {
      result = (await auth.api.getAccessToken({
        body: { providerId: 'microsoft', userId },
      })) as { accessToken?: string | null; scopes?: string[] };
    } catch (cause) {
      throw tokenFailure(cause);
    }

    if (!result?.accessToken) {
      throw new GraphError(
        'reauth_required',
        'Ingen Microsoft-konto er forbundet. Log ind med Microsoft igen.',
        { status: 401 },
      );
    }

    return { accessToken: result.accessToken, scopes: parseScopes(result.scopes) };
  });
}

/**
 * A new access token whether or not the stored one has expired — for a Graph 401
 * on a token better-auth still believed was good (revoked session, clock skew).
 * Shares one flight per user, so calls rejected together refresh once.
 */
function forceRefreshToken(userId: string): Promise<string> {
  return singleFlight(refreshFlights, userId, async () => {
    try {
      const result = (await auth.api.refreshToken({
        body: { providerId: 'microsoft', userId },
      })) as { accessToken?: string | null };
      if (result?.accessToken) return result.accessToken;
    } catch (cause) {
      throw tokenFailure(cause);
    }
    throw new GraphError(
      'reauth_required',
      'Ingen Microsoft-konto er forbundet. Log ind med Microsoft igen.',
      { status: 401 },
    );
  });
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

/** One fetch, bounded by `timeoutMs`; a timeout or a network failure is the transient error. */
async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, signal });
  } catch (cause) {
    throw new GraphError('unavailable', isAbortError(cause) ? TIMEOUT_MESSAGE : UNAVAILABLE_MESSAGE, {
      cause,
    });
  }
}

/**
 * The same mapping for a body that stalls or is cut off after the headers came
 * back — the request's timeout keeps running while it is read.
 */
export function asTransient(err: unknown): unknown {
  if (err instanceof GraphError) return err;
  if (isAbortError(err)) return new GraphError('unavailable', TIMEOUT_MESSAGE, { cause: err });
  // undici reports a connection dropped mid-body as TypeError('terminated').
  if (err instanceof TypeError) return new GraphError('unavailable', UNAVAILABLE_MESSAGE, { cause: err });
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the failed response's body no further: it is being replaced by a retry. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

/**
 * One Graph call. Returns the raw Response on 2xx so callers can stream a
 * recording body straight to disk (and on a 3xx when the caller follows
 * redirects itself); every other status becomes a typed GraphError.
 *
 * Three things are repeated here so no caller has to: a 401 once with a forced
 * token refresh, a 429/503 that says how long to wait (see the constants), and
 * nothing else — every other failure is the caller's to classify.
 */
export async function graphFetch(
  userId: string,
  path: string,
  init: RequestInit = {},
  options: { timeoutMs?: number } = {},
): Promise<Response> {
  const { url, isGraph } = resolveUrl(path);
  const timeoutMs = options.timeoutMs ?? GRAPH_TIMEOUT_MS;
  let token = isGraph ? await getGraphAccessToken(userId) : null;
  let refreshed = false;
  let retries = 0;
  let waitedMs = 0;

  for (;;) {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const res = await timedFetch(url, { ...init, headers }, timeoutMs);
    if (res.ok) return res;
    if (init.redirect === 'manual' && res.status >= 300 && res.status < 400) return res;

    if (res.status === 401 && token && !refreshed) {
      refreshed = true;
      await discard(res);
      // Someone else may have refreshed since this call took its token; only
      // force one when better-auth still hands back the token that was refused.
      const current = await getGraphAccessToken(userId);
      token = current !== token ? current : await forceRefreshToken(userId);
      continue;
    }

    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    if (
      (res.status === 429 || res.status === 503) &&
      retryAfterMs !== null &&
      retries < RETRY_AFTER_MAX_RETRIES &&
      waitedMs + retryAfterMs <= RETRY_AFTER_BUDGET_MS
    ) {
      await discard(res);
      await sleep(retryAfterMs);
      retries += 1;
      waitedMs += retryAfterMs;
      continue;
    }

    return raise(res, retryAfterMs);
  }
}

async function raise(res: Response, retryAfterMs: number | null): Promise<never> {
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
  throw new GraphError(
    isRetryableStatus(res.status) ? 'unavailable' : 'http',
    `Microsoft Graph svarede ${res.status}${detail}`,
    { status: res.status, retryAfterMs },
  );
}

/** graphFetch + JSON. Paging (`@odata.nextLink`) is the caller's business. */
export async function graphJson<T>(
  userId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await graphFetch(userId, path, init);
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw asTransient(err);
  }
}

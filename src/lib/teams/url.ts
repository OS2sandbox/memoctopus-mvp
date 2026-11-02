/**
 * Teams meeting URL validation and join-context parsing.
 *
 * Rejects a link before it ever reaches Microsoft Graph. Ported from the
 * removed bot-service's url-validator (see tag bot-service-final).
 * Acceptance criteria are deliberately tight:
 *   - parses as a URL after trimming surrounding whitespace
 *   - the scheme is https (no protocol downgrade, no `javascript:` smuggling)
 *   - the host is exactly teams.microsoft.com or teams.live.com — no subdomain
 *     spoofing (`evil.teams.microsoft.com`) and no suffix spoofing
 *     (`teams.microsoft.com.evil.com`)
 *
 * One exception to the tight host rule: a link copied out of an Outlook email in
 * a tenant running Microsoft Defender Safe Links has been rewritten to
 * `<region>.safelinks.protection.outlook.com/?url=<the real link>`. That is the
 * link most users have to hand, so we unwrap it rather than telling them their
 * own invite is invalid. Unwrapping widens which *inputs* are accepted, never
 * which *destinations*: whatever comes out goes through the same https and
 * allowed-host checks as a link pasted directly.
 *
 * `ok: true` carries the normalized href, which is what we hand to Graph's
 * `$filter=JoinWebUrl eq '<url>'` lookup. Node's URL preserves query-string
 * percent-encoding verbatim, and Safe Links encodes the original link whole, so
 * the unwrapped string is byte-identical to what Graph stored as JoinWebUrl —
 * which matters, because that filter is an exact string comparison.
 */

const ALLOWED_HOSTS = new Set<string>(['teams.microsoft.com', 'teams.live.com']);

const SAFELINKS_HOST = 'safelinks.protection.outlook.com';

/** Safe Links wrappers are regional (eur03., nam02., …), and occasionally nested. */
const MAX_UNWRAP_DEPTH = 3;

function isSafeLinksHost(hostname: string): boolean {
  // The leading dot is load-bearing: it keeps `evilsafelinks.protection.outlook.com`
  // and `safelinks.protection.outlook.com.evil.com` out.
  return hostname === SAFELINKS_HOST || hostname.endsWith(`.${SAFELINKS_HOST}`);
}

export type TeamsUrlCheck = { ok: true; url: string } | { ok: false; reason: 'invalid-url' | 'wrong-host' };

export function validateTeamsUrl(input: string): TeamsUrlCheck {
  if (typeof input !== 'string') return { ok: false, reason: 'invalid-url' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'invalid-url' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }

  // A non-https scheme is not a "wrong host" — it can't be a real join link at all.
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'invalid-url' };

  for (let depth = 0; isSafeLinksHost(parsed.hostname) && depth < MAX_UNWRAP_DEPTH; depth += 1) {
    // searchParams decodes the wrapper's encoding, handing back the original link.
    const wrapped = parsed.searchParams.get('url');
    if (!wrapped) return { ok: false, reason: 'invalid-url' };
    try {
      parsed = new URL(wrapped.trim());
    } catch {
      return { ok: false, reason: 'invalid-url' };
    }
    if (parsed.protocol !== 'https:') return { ok: false, reason: 'invalid-url' };
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) return { ok: false, reason: 'wrong-host' };

  return { ok: true, url: parsed.href };
}

export interface TeamsJoinContext {
  threadId?: string;
  organizerOid?: string;
  tenantId?: string;
}

/**
 * Best-effort parse of a join link's identifiers. A classic link looks like
 *
 *   https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0
 *     ?context=%7b%22Tid%22%3a%22<tenant>%22%2c%22Oid%22%3a%22<organizer>%22%7d
 *
 * Short links (`teams.live.com/meet/123`) carry none of this, and Graph is the
 * authority anyway — so every field is optional and this function never throws.
 */
export function extractJoinContext(url: string): TeamsJoinContext {
  const out: TeamsJoinContext = {};
  if (typeof url !== 'string') return out;

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return out;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  const joinIdx = segments.indexOf('meetup-join');
  if (joinIdx !== -1 && segments[joinIdx + 1]) {
    const raw = segments[joinIdx + 1];
    let thread = raw;
    try {
      thread = decodeURIComponent(raw);
    } catch {
      // Malformed percent-escapes: keep the raw segment rather than dropping it.
    }
    if (thread.includes('@thread.')) out.threadId = thread;
  }

  const context = parsed.searchParams.get('context');
  if (context) {
    try {
      const parsedContext = JSON.parse(context) as Record<string, unknown>;
      const tid = parsedContext.Tid ?? parsedContext.tid;
      const oid = parsedContext.Oid ?? parsedContext.oid;
      if (typeof tid === 'string' && tid) out.tenantId = tid;
      if (typeof oid === 'string' && oid) out.organizerOid = oid;
    } catch {
      // Not JSON (or truncated by a mail client) — the ids simply stay unknown.
    }
  }

  return out;
}

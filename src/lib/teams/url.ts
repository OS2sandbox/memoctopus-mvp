/**
 * Teams meeting URL validation and join-context parsing.
 *
 * Ported from the bot-service validator (`bot-service/src/lib/url-validator.ts`)
 * so the Next.js side can reject a link before it ever reaches Microsoft Graph.
 * Acceptance criteria are deliberately tight:
 *   - parses as a URL after trimming surrounding whitespace
 *   - the scheme is https (no protocol downgrade, no `javascript:` smuggling)
 *   - the host is exactly teams.microsoft.com or teams.live.com — no subdomain
 *     spoofing (`evil.teams.microsoft.com`) and no suffix spoofing
 *     (`teams.microsoft.com.evil.com`)
 *
 * `ok: true` carries the normalized href, which is what we hand to Graph's
 * `$filter=JoinWebUrl eq '<url>'` lookup.
 */

const ALLOWED_HOSTS = new Set<string>(['teams.microsoft.com', 'teams.live.com']);

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

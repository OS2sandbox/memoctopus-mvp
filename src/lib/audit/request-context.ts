// ip / user agent / request id for audit rows and the app log. The client IP is
// read from the SAME header list better-auth is configured with (AUTH_IP_HEADERS,
// default x-forwarded-for), so both agree on which proxy header to trust.
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { authIpHeaders } from '@/lib/auth/ip-headers';

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface HeaderSource {
  headers: { get(name: string): string | null };
}

const MAX_USER_AGENT = 255;

function normaliseIp(raw: string): string | null {
  let v = raw.trim();
  if (!v) return null;
  // "[::1]:443" and "1.2.3.4:443" -> bare address.
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracket) v = bracket[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(':'));
  return isIP(v) ? v : null;
}

/** First valid address from the configured proxy headers; null when none (or the header is absent). */
export function clientIp(req: HeaderSource): string | null {
  for (const name of authIpHeaders() ?? ['x-forwarded-for']) {
    const value = req.headers.get(name);
    if (!value) continue;
    // A forwarded chain is "client, proxy1, proxy2": the first entry is the client.
    const ip = normaliseIp(value.split(',')[0] ?? '');
    if (ip) return ip;
  }
  return null;
}

/** Control characters have no business in a log column; capped at 255. */
export function cleanUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = ua.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_USER_AGENT);
  return cleaned || null;
}

export function userAgentOf(req: HeaderSource): string | null {
  return cleanUserAgent(req.headers.get('user-agent'));
}

// Only id shapes a proxy or client really generates are honoured (a UUID, or the
// 32 hex digits of nginx's $request_id). Any other value is attacker-chosen text
// that would otherwise be stored in audit rows and printed in app-log lines.
const REQUEST_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

// Same request object -> same id, so withHandler's log line, the response header
// and the audit row written inside the handler all carry one id even when the
// caller sent no x-request-id.
const generated = new WeakMap<object, string>();

export function requestIdOf(req: HeaderSource): string {
  const given = req.headers.get('x-request-id');
  if (given && REQUEST_ID_RE.test(given)) return given;
  let id = generated.get(req);
  if (!id) {
    id = randomUUID();
    generated.set(req, id);
  }
  return id;
}

export function requestContext(req: HeaderSource): RequestContext {
  return { ip: clientIp(req), userAgent: userAgentOf(req), requestId: requestIdOf(req) };
}

/** Narrow an unknown handler argument to something with headers. */
export function asHeaderSource(value: unknown): HeaderSource | null {
  const headers = (value as { headers?: { get?: unknown } } | null)?.headers;
  return headers && typeof headers.get === 'function' ? (value as HeaderSource) : null;
}

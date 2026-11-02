// URL primitives behind the "https unless loopback" rules of the IdP config (auth/config-file.ts) and
// the Rollekatalog URL (rollekatalog/config.ts). Each caller layers its own exceptions on top (the
// IdP rule is https-only in production, Rollekatalog has ROLLEKATALOG_ALLOW_HTTP); only the host and
// scheme checks are shared.

// URL.hostname keeps the brackets of an IPv6 literal; the bare form is accepted too.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const isLoopbackHost = (hostname: string): boolean => LOOPBACK_HOSTS.has(hostname);

/** https, or http for a loopback host (unless `allowLoopbackHttp` is false: then https only). */
export function isHttpsOrLoopbackHttp(u: URL, allowLoopbackHttp = true): boolean {
  if (u.protocol === 'https:') return true;
  return allowLoopbackHttp && u.protocol === 'http:' && isLoopbackHost(u.hostname);
}

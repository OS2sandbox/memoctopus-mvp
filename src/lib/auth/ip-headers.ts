// Optional override of the headers better-auth reads the client IP from. Unset
// keeps better-auth's default (x-forwarded-for). Set it to match the reverse
// proxy, which must overwrite any client-supplied value, e.g.
// AUTH_IP_HEADERS=x-real-ip,x-forwarded-for
//
// betterAuth() is constructed once at module load, so the value is read there
// (a restart applies a change, no rebuild) like the provider config.
export function authIpHeaders(): string[] | undefined {
  const headers = (process.env.AUTH_IP_HEADERS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return headers.length > 0 ? headers : undefined;
}

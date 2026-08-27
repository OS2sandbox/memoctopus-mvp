/**
 * Teams meeting URL validator.
 *
 * Acceptance criteria:
 *   - parses as a URL
 *   - host is teams.microsoft.com or teams.live.com (exact match, no subdomain
 *     spoofing, no protocol downgrade — Playwright's goto enforces protocol
 *     handling but we keep the host check tight)
 *
 * Anything else is rejected with a structured reason. Used by the Express
 * route handler in src/index.ts so the bot never launches Chromium for a
 * URL that can't possibly be a Teams meeting.
 */

const ALLOWED_HOSTS = new Set<string>(['teams.microsoft.com', 'teams.live.com']);

export type ValidationResult =
  | { ok: true; url: URL }
  | { ok: false; reason: 'invalid-url' | 'wrong-host' };

export function validateTeamsUrl(input: unknown): ValidationResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'invalid-url' };
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return { ok: false, reason: 'wrong-host' };
  }
  return { ok: true, url: parsed };
}

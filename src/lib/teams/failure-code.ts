import { GraphError } from './graph-client';
import { ResolveError } from './meeting-resolver';

/**
 * A short code for the audit log saying why a Teams action failed, from a CLOSED set: a GraphError's
 * own code (`consent_required`, `reauth_required`, `forbidden`, `unavailable`, ...), `http_<status>`
 * for a Graph answer without a better code, `resolve_<code>` for a join link that could not be
 * resolved, and `unknown` for anything else. Never the message, which can carry Graph's text.
 */
export function teamsFailureCode(err: unknown): string {
  if (err instanceof GraphError) {
    if (err.code !== 'http') return err.code;
    return Number.isInteger(err.status) && err.status >= 100 && err.status <= 599 ? `http_${err.status}` : 'http';
  }
  if (err instanceof ResolveError) return `resolve_${err.code.replace(/-/g, '_')}`;
  return 'unknown';
}

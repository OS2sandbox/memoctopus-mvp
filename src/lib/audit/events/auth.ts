// Login lifecycle and authorisation denials. No entity on the login events: the
// actor is the user. Never the email itself; `emailHmac` is an optional keyed hash
// so repeated failures can be correlated. A denial carries only the guard that
// refused and a short machine reason.
import { z } from 'zod';
import { code, count, defineEvent } from './types';

// 'password' | 'oidc' | 'microsoft' | 'saml' come from the better-auth route that created or
// rejected the session; 'unknown' when the route is none of those.
const method = () => z.enum(['password', 'oidc', 'microsoft', 'saml', 'unknown']);

export const authEvents = {
  'auth.login': defineEvent({
    sources: ['server'],
    entityType: null,
    entityIdRequired: false,
    details: z.object({ method: method(), provider: code() }).strict(),
  }),
  'auth.logout': defineEvent({
    sources: ['server'],
    entityType: null,
    entityIdRequired: false,
    details: z.object({}).strict(),
  }),
  // Never carries the attempted email: only emailHmac (first 16 hex chars of an
  // HMAC-SHA256 keyed with BETTER_AUTH_SECRET over the lower-cased address).
  'auth.login_failed': defineEvent({
    sources: ['server'],
    entityType: null,
    entityIdRequired: false,
    defaultOutcome: 'error',
    details: z
      .object({
        reason: z.enum(['invalid_credentials', 'oauth_error', 'account_not_linked', 'rate_limited', 'burst_summary', 'unknown']),
        method: method().optional(),
        provider: code().optional(),
        emailHmac: z.string().regex(/^[0-9a-f]{16,64}$/).optional(),
        // On a reason 'burst_summary' row: this many further failures from the same address in
        // the same minute were NOT stored one by one (see login-hook.ts), so a burst is still evidenced.
        droppedCount: count().min(1).optional(),
      })
      .strict(),
  }),
  'authz.denied': defineEvent({
    sources: ['server'],
    entityType: null,
    anyEntityType: true,
    entityIdRequired: false,
    defaultOutcome: 'denied',
    // required = the capability or guard that refused, reason = short machine reason.
    details: z.object({ required: code(), reason: code() }).strict(),
  }),
} as const;

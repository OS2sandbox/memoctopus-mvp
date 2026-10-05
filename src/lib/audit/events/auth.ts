// Login lifecycle. No entity: the actor is the user. Never the email itself;
// `emailHmac` is an optional keyed hash so repeated failures can be correlated.
import { z } from 'zod';
import { code, defineEvent } from './types';

// 'password' | 'oidc' | 'microsoft' come from the better-auth route that created or
// rejected the session; 'unknown' when the route is none of those. 'sso' is kept
// only for senders that cannot tell which IdP (e.g. a browser-reported failure).
const method = () => z.enum(['password', 'oidc', 'microsoft', 'sso', 'unknown']);

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
    // 'client' too: a browser-side sign-in failure has no session to report from.
    sources: ['server', 'client'],
    entityType: null,
    entityIdRequired: false,
    defaultOutcome: 'error',
    details: z
      .object({
        reason: z.enum(['invalid_credentials', 'oauth_error', 'account_not_linked', 'rate_limited', 'unknown']),
        method: method().optional(),
        provider: code().optional(),
        emailHmac: z.string().regex(/^[0-9a-f]{16,64}$/).optional(),
      })
      .strict(),
  }),
} as const;

import { genericOAuthClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { ssoClient } from '@better-auth/sso/client';

export const authClient = createAuthClient({
  baseURL:
    typeof window !== 'undefined'
      ? window.location.origin
      : process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3004',
  // ssoClient adds signIn.sso for SAML providers; the endpoint only exists when one is configured.
  plugins: [genericOAuthClient(), ssoClient()],
});

export const { signIn, signOut, signUp, useSession } = authClient;

export type Session = typeof authClient.$Infer.Session;
export type User = Session['user'];

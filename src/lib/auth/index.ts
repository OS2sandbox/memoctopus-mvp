import { betterAuth } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import { pool } from '@/lib/db';

if (process.env.NODE_ENV === 'production') {
  if (!process.env.BETTER_AUTH_SECRET) {
    throw new Error('BETTER_AUTH_SECRET env var is required in production');
  }
  if (process.env.BETTER_AUTH_SECRET === 'change-me') {
    throw new Error('BETTER_AUTH_SECRET must not be the default "change-me" value in production');
  }
}

const emailPasswordEnabled = process.env.NEXT_PUBLIC_EMAIL_PASSWORD_ENABLED !== 'false';

const microsoftEnabled =
  process.env.NEXT_PUBLIC_MICROSOFT_ENABLED === 'true' &&
  Boolean(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);

const authentikEnabled =
  process.env.NEXT_PUBLIC_AUTHENTIK_ENABLED === 'true' &&
  Boolean(
    process.env.AUTHENTIK_CLIENT_ID &&
    process.env.AUTHENTIK_CLIENT_SECRET &&
    process.env.AUTHENTIK_DISCOVERY_URL,
  );

const plugins = authentikEnabled
  ? [
      genericOAuth({
        config: [
          {
            providerId: 'authentik',
            clientId: process.env.AUTHENTIK_CLIENT_ID as string,
            clientSecret: process.env.AUTHENTIK_CLIENT_SECRET as string,
            discoveryUrl: process.env.AUTHENTIK_DISCOVERY_URL as string,
            scopes: ['openid', 'profile', 'email'],
            pkce: true,
          },
        ],
      }),
    ]
  : [];

export const auth = betterAuth({
  database: pool,
  secret: process.env.BETTER_AUTH_SECRET || 'fallback-secret-key-for-development-only',
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3004',
  trustedOrigins: [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3004',
    'http://127.0.0.1:3004',
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS
      ? process.env.BETTER_AUTH_TRUSTED_ORIGINS.split(',').map((s) => s.trim())
      : []),
  ],
  user: {
    modelName: 'users',
    fields: {
      emailVerified: 'email_verified',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  session: {
    modelName: 'sessions',
    expiresIn: 86_400 * 7,
    updateAge: 86_400,
    fields: {
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      ipAddress: 'ip_address',
      userAgent: 'user_agent',
      userId: 'user_id',
    },
  },
  account: {
    modelName: 'accounts',
    accountLinking: {
      enabled: true,
      trustedProviders: ['authentik'],
    },
    fields: {
      accountId: 'account_id',
      providerId: 'provider_id',
      userId: 'user_id',
      accessToken: 'access_token',
      refreshToken: 'refresh_token',
      idToken: 'id_token',
      accessTokenExpiresAt: 'access_token_expires_at',
      refreshTokenExpiresAt: 'refresh_token_expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  verification: {
    modelName: 'verifications',
    fields: {
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  emailAndPassword: {
    enabled: emailPasswordEnabled,
    requireEmailVerification: false,
    minPasswordLength: 8,
  },
  socialProviders: microsoftEnabled
    ? {
        microsoft: {
          clientId: process.env.MICROSOFT_CLIENT_ID as string,
          clientSecret: process.env.MICROSOFT_CLIENT_SECRET as string,
          tenantId: process.env.MICROSOFT_TENANT_ID || 'common',
          prompt: 'select_account',
        },
      }
    : {},
  plugins,
});

export type Auth = typeof auth;

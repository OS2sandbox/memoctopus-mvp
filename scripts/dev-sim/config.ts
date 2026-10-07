// Shared constants for the local simulation stack (see docs/central-access/dev-simulation.md).
// Everything here is a PUBLIC, throwaway test value. The stack binds to 127.0.0.1 only and
// refuses to start with NODE_ENV=production.
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const SIM = {
  appUrl: process.env.SIM_APP_URL ?? 'http://localhost:3004',
  rollekatalogPort: Number(process.env.SIM_ROLLEKATALOG_PORT ?? 4010),
  controlPort: Number(process.env.SIM_CONTROL_PORT ?? 4011),
  idpPort: Number(process.env.SIM_IDP_PORT ?? 4020),
  llmPort: Number(process.env.SIM_LLM_PORT ?? 4030),
  samlPort: Number(process.env.SIM_SAML_PORT ?? 4021),
  oidc: {
    // Must equal OIDC_PROVIDER_ID in the app env (the callback path carries it).
    providerId: 'oidc',
    clientId: 'sim-client',
    clientSecret: 'sim-client-secret',
  },
  saml: {
    // Must equal the provider "id" in auth-config.claims.json (the ACS path carries it).
    providerId: 'saml',
    // Written by the SAML stand-in at start-up, read by the app (idpMetadataFile).
    metadataFile: path.join(os.tmpdir(), 'referat-dev-sim', 'saml-idp-metadata.xml'),
  },
  cronSecret: 'sim-cron-secret',
  feedKey: 'sim-feed-key',
  feedKeyHash: createHash('sha256').update('sim-feed-key').digest('hex'),
} as const;

export const idpUrl = `http://127.0.0.1:${SIM.idpPort}`;
export const samlUrl = `http://127.0.0.1:${SIM.samlPort}`;
export const rollekatalogUrl = `http://127.0.0.1:${SIM.rollekatalogPort}`;
export const controlUrl = `http://127.0.0.1:${SIM.controlPort}`;
export const llmUrl = `http://127.0.0.1:${SIM.llmPort}/v1`;

export function refuseInProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    console.error('dev-sim refuses to run with NODE_ENV=production.');
    process.exit(1);
  }
}

/** The auth config file of the claims mode: OIDC + SAML stand-ins, role mapping, catalogue. */
export const claimsAuthConfigFile = path.resolve(__dirname, 'auth-config.claims.json');

/**
 * The .env block for the app under test. Printed by `index.ts --env` and used by the acceptance script.
 * mode 'claims' (SIM_ACCESS_SOURCE=claims) runs the app the way a municipality does: roles from the
 * IdP's claims, both stand-in IdPs configured by the JSON file, no local role admin, no Rollekatalog.
 */
export function appEnv(databaseUrl: string, mode: string | undefined = undefined): Record<string, string> {
  if (mode === 'claims') {
    return {
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_URL: SIM.appUrl,
      BETTER_AUTH_SECRET: 'sim-only-secret-sim-only-secret-0123456789',
      ACCESS_SOURCE: 'claims',
      REQUIRE_ROLE_TO_LOGIN: 'true',
      AUTH_CONFIG_FILE: claimsAuthConfigFile,
      // Referenced by ${...} in the config file, so the file itself carries no secret.
      SIM_OIDC_CLIENT_ID: SIM.oidc.clientId,
      SIM_OIDC_CLIENT_SECRET: SIM.oidc.clientSecret,
      SIM_OIDC_DISCOVERY_URL: `${idpUrl}/.well-known/openid-configuration`,
      SIM_SAML_METADATA_FILE: SIM.saml.metadataFile,
      // Password sign-up stays on here to prove it never inherits a role.
      EMAIL_PASSWORD_ENABLED: 'true',
      INTERNAL_CRON_SECRET: SIM.cronSecret,
      // Rollekatalog is only the role CATALOGUE here (READ key; the user/organisation sync is off).
      ROLLEKATALOG_URL: rollekatalogUrl,
      ROLLEKATALOG_READ_API_KEY: 'mock-read-key-0000',
      AUDIT_FEED_API_KEY_HASH: SIM.feedKeyHash,
      AUDIT_FEED_DELAY_SECONDS: '0',
      LLM_BASE_URL: llmUrl,
      LLM_MODEL: 'sim-model',
      OPENAI_API_KEY: '',
    };
  }
  return {
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_URL: SIM.appUrl,
    BETTER_AUTH_SECRET: 'sim-only-secret-sim-only-secret-0123456789',
    // Access control from the simulated Rollekatalog.
    ACCESS_SOURCE: 'rollekatalog',
    REQUIRE_ROLE_TO_LOGIN: 'true',
    BOOTSTRAP_ADMIN_EMAILS: '',
    ROLLEKATALOG_URL: rollekatalogUrl,
    ROLLEKATALOG_READ_API_KEY: 'mock-read-key-0000',
    ROLLEKATALOG_ORG_API_KEY: 'mock-org-key-0000',
    ROLLEKATALOG_ITSYSTEM_ID: 'os2taletiltekst',
    ROLLEKATALOG_DOMAIN: '',
    ROLLEKATALOG_GLOBAL_ROLES: 'tt-administrator',
    DIRECTORY_MATCH: 'userid-claim',
    DIRECTORY_USERID_CLAIM: 'preferred_username',
    INTERNAL_CRON_SECRET: SIM.cronSecret,
    // Login through the simulated IdP; email/password stays on to prove it never inherits roles.
    OIDC_CLIENT_ID: SIM.oidc.clientId,
    OIDC_CLIENT_SECRET: SIM.oidc.clientSecret,
    OIDC_DISCOVERY_URL: `${idpUrl}/.well-known/openid-configuration`,
    OIDC_PROVIDER_ID: SIM.oidc.providerId,
    OIDC_PROVIDER_NAME: 'Simuleret kommune-login',
    OIDC_PKCE: 'true',
    EMAIL_PASSWORD_ENABLED: 'true',
    // Audit.
    AUDIT_FEED_API_KEY_HASH: SIM.feedKeyHash,
    AUDIT_FEED_DELAY_SECONDS: '0',
    // Minutes generation goes to the simulated LLM, which records what it was sent.
    LLM_BASE_URL: llmUrl,
    LLM_MODEL: 'sim-model',
    OPENAI_API_KEY: '',
  };
}

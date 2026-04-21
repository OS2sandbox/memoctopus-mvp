import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import { Pool } from "pg";

const DEFAULT_TRUSTED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const parseTrustedOrigins = (raw: string | undefined): string[] => {
  if (!raw) return DEFAULT_TRUSTED_ORIGINS;
  const origins = raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : DEFAULT_TRUSTED_ORIGINS;
};

const authentikEnabled = Boolean(
  process.env["AUTHENTIK_CLIENT_ID"] &&
    process.env["AUTHENTIK_CLIENT_SECRET"] &&
    process.env["AUTHENTIK_DISCOVERY_URL"],
);

const plugins = authentikEnabled
  ? [
      genericOAuth({
        config: [
          {
            providerId: "authentik",
            clientId: process.env["AUTHENTIK_CLIENT_ID"] as string,
            clientSecret: process.env["AUTHENTIK_CLIENT_SECRET"] as string,
            discoveryUrl: process.env["AUTHENTIK_DISCOVERY_URL"] as string,
            scopes: ["openid", "profile", "email"],
            pkce: true,
          },
        ],
      }),
    ]
  : [];

export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env["DATABASE_URL"],
  }),
  secret:
    process.env["BETTER_AUTH_SECRET"] || "fallback-secret-key-for-development",
  baseURL: process.env["BETTER_AUTH_URL"] || "http://localhost:3000",
  trustedOrigins: parseTrustedOrigins(process.env["TRUSTED_ORIGINS"]),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
  },
  socialProviders:
    process.env["MICROSOFT_CLIENT_ID"] && process.env["MICROSOFT_CLIENT_SECRET"]
      ? {
          microsoft: {
            clientId: process.env["MICROSOFT_CLIENT_ID"] as string,
            clientSecret: process.env["MICROSOFT_CLIENT_SECRET"] as string,
            tenantId: process.env["MICROSOFT_TENANT_ID"] || "common",
            prompt: "select_account",
          },
        }
      : {},
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["authentik"],
    },
  },
  plugins,
  session: {
    expiresIn: 86_400 * 7, // 7 days
    updateAge: 86_400, // 1 day
  },
});

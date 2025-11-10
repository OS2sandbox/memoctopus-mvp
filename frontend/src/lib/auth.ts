import { betterAuth } from "better-auth";
import { Pool } from "pg";

export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env["DATABASE_URL"],
  }),
  secret: process.env["BETTER_AUTH_SECRET"] || "fallback-secret-key-for-development",
  baseURL: process.env["BETTER_AUTH_URL"] || "http://localhost:3000",
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
  },
  // Temporarily disable social providers to isolate the issue
  // socialProviders: process.env["MICROSOFT_CLIENT_ID"] && process.env["MICROSOFT_CLIENT_SECRET"] ? {
  //   microsoft: {
  //     clientId: process.env["MICROSOFT_CLIENT_ID"] as string,
  //     clientSecret: process.env["MICROSOFT_CLIENT_SECRET"] as string,
  //     tenantId: "common", // Use 'common' for multi-tenant, or specific tenant ID
  //     authority: "https://login.microsoftonline.com",
  //     prompt: "select_account",
  //   },
  // } : {},
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
  },
});

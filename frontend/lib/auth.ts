import { betterAuth } from "better-auth";
import { Pool } from "pg";

export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env["DATABASE_URL"],
  }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    microsoft: {
      clientId: process.env["MICROSOFT_CLIENT_ID"] as string,
      clientSecret: process.env["MICROSOFT_CLIENT_SECRET"] as string,
      tenantId: "common", // Use 'common' for multi-tenant, or specific tenant ID
      authority: "https://login.microsoftonline.com",
      prompt: "select_account",
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
  },
});

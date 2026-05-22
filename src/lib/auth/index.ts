import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { ensureUserSchema } from '@/lib/db/user-schema';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
});

export const auth = betterAuth({
  database: {
    db: pool,
    type: 'pg',
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // update session every 24 hours
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            await ensureUserSchema(user.id);
          } catch (err) {
            console.error('Failed to create user schema for', user.id, err);
          }
        },
      },
    },
  },
  trustedOrigins: [process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'],
});

export type Auth = typeof auth;

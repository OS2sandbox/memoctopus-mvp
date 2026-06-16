import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  pgEnum,
} from 'drizzle-orm/pg-core';

// ─── Shared (public) schema — better-auth tables ───────────────────────────

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
});

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Published Skabeloner live in the shared (public) schema so they can be shared
// across users. Each row is reachable via its random `token` import link; the
// recipient copies it into their own per-user `skabeloner` table.
export const sharedSkabeloner = pgTable('shared_skabeloner', {
  token: text('token').primaryKey(),
  ownerUserId: text('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  prompt: text('prompt').notNull().default(''),
  includeDeltagere: boolean('include_deltagere').notNull().default(false),
  includeBeslutningspunkter: boolean('include_beslutningspunkter').notNull().default(false),
  includeDagsorden: boolean('include_dagsorden').notNull().default(false),
  includeDato: boolean('include_dato').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ─── Per-user schema helpers ────────────────────────────────────────────────
// These are the SQL strings used when building per-user schemas.
// Drizzle cannot target dynamic schema names, so we use raw SQL in user-schema.ts.

export const meetingStatusValues = [
  'joining',
  'recording',
  'processing',
  'review',
  'minutes',
  'done',
  'redacted',
] as const;

export type MeetingStatusValue = (typeof meetingStatusValues)[number];

// Exported only for type inference — actual tables live in per-user schemas.
export const meetingStatusEnum = pgEnum('meeting_status', meetingStatusValues);

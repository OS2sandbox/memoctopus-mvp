import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  pgEnum,
  uuid,
  primaryKey,
  unique,
  index,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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

// ─── Central access control (public schema) ────────────────────────────────
// One set of mirror tables fed by two sources (`source` = 'local' admin UI or
// 'rollekatalog' sync). Permission code reads only these tables.
// Requires PostgreSQL 15+ (UNIQUE ... NULLS NOT DISTINCT on role_assignments).

export const accessSourceValues = ['local', 'rollekatalog'] as const;
const sourceIn = (col: string) => sql.raw(`"${col}" in ('local', 'rollekatalog')`);

export const directoryUsers = pgTable(
  'directory_users',
  {
    uuid: uuid('uuid').primaryKey().defaultRandom(),
    extUuid: uuid('ext_uuid').unique(),
    extUserId: text('ext_user_id'),
    name: text('name').notNull(),
    email: text('email'),
    disabled: boolean('disabled').notNull().default(false),
    // Direct link to an app account. Local mode relies on this and never on email.
    appUserId: text('app_user_id')
      .unique()
      .references(() => users.id, { onDelete: 'set null' }),
    source: text('source').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('directory_users_source_check', sourceIn('source'))],
);

export const orgUnits = pgTable(
  'org_units',
  {
    uuid: uuid('uuid').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    parentUuid: uuid('parent_uuid').references((): AnyPgColumn => orgUnits.uuid, {
      onDelete: 'restrict',
    }),
    managerUuid: uuid('manager_uuid').references(() => directoryUsers.uuid, {
      onDelete: 'set null',
    }),
    source: text('source').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('org_units_parent_uuid_idx').on(t.parentUuid),
    check('org_units_source_check', sourceIn('source')),
  ],
);

export const orgUnitMembers = pgTable(
  'org_unit_members',
  {
    directoryUserUuid: uuid('directory_user_uuid')
      .notNull()
      .references(() => directoryUsers.uuid, { onDelete: 'cascade' }),
    orgUnitUuid: uuid('org_unit_uuid')
      .notNull()
      .references(() => orgUnits.uuid, { onDelete: 'cascade' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    title: text('title'),
  },
  (t) => [primaryKey({ columns: [t.directoryUserUuid, t.orgUnitUuid] })],
);

export const orgUnitSubstitutes = pgTable(
  'org_unit_substitutes',
  {
    managerUuid: uuid('manager_uuid')
      .notNull()
      .references(() => directoryUsers.uuid, { onDelete: 'cascade' }),
    substituteUuid: uuid('substitute_uuid')
      .notNull()
      .references(() => directoryUsers.uuid, { onDelete: 'cascade' }),
    orgUnitUuid: uuid('org_unit_uuid')
      .notNull()
      .references(() => orgUnits.uuid, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.managerUuid, t.substituteUuid, t.orgUnitUuid] })],
);

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    directoryUserUuid: uuid('directory_user_uuid')
      .notNull()
      .references(() => directoryUsers.uuid, { onDelete: 'cascade' }),
    // Free text on purpose: unknown keys synced from Rollekatalog are ignored by the resolver.
    roleKey: text('role_key').notNull(),
    // NULL = no org-unit scope (global only for roles that allow it; see authz/capabilities.ts).
    scopeOrgUnitUuid: uuid('scope_org_unit_uuid').references(() => orgUnits.uuid, {
      onDelete: 'cascade',
    }),
    includeDescendants: boolean('include_descendants').notNull().default(true),
    source: text('source').notNull(),
    startDate: timestamp('start_date', { withTimezone: true }),
    stopDate: timestamp('stop_date', { withTimezone: true }),
    createdByUserId: text('created_by_user_id'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT: two global grants of the same role would otherwise both be allowed.
    unique('role_assignments_user_role_scope_source_unique')
      .on(t.directoryUserUuid, t.roleKey, t.scopeOrgUnitUuid, t.source)
      .nullsNotDistinct(),
    index('role_assignments_directory_user_idx').on(t.directoryUserUuid),
    check('role_assignments_source_check', sourceIn('source')),
    check(
      'role_assignments_dates_check',
      sql`${t.startDate} is null or ${t.stopDate} is null or ${t.stopDate} > ${t.startDate}`,
    ),
  ],
);

// Login -> directory link for SSO accounts. `claims` is a whitelisted snapshot
// (never the raw token), written by the login hook.
export const externalIdentities = pgTable(
  'external_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    subject: text('subject').notNull(),
    claims: jsonb('claims').notNull().default({}),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('external_identities_provider_subject_unique').on(t.providerId, t.subject),
    index('external_identities_user_id_idx').on(t.userId),
  ],
);

export const syncRunStatusValues = ['running', 'success', 'failed'] as const;

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').notNull(),
    counts: jsonb('counts'),
    errorCode: text('error_code'),
  },
  (t) => [check('sync_runs_status_check', sql`${t.status} in ('running', 'success', 'failed')`)],
);

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

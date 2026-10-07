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
  uniqueIndex,
  bigserial,
  check,
  foreignKey,
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
// One set of mirror tables fed by three sources (`source` = 'local' admin UI,
// 'rollekatalog' sync, or 'claims': role rows written at login from the IdP's claims).
// Permission code reads only these tables.
// Requires PostgreSQL 15+ (UNIQUE ... NULLS NOT DISTINCT on role_assignments).

const sourceIn = (col: string) => sql.raw(`"${col}" in ('local', 'rollekatalog', 'claims')`);

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
  (t) => [
    // directory-match.ts compares lower(ext_user_id) and lower(email) (FOR UPDATE) on every
    // SSO login; plain columns would be seq-scanned and row-locked on a large mirror.
    index('directory_users_ext_user_id_lower_idx').on(sql`lower(${t.extUserId})`),
    index('directory_users_email_lower_idx').on(sql`lower(${t.email})`),
    check('directory_users_source_check', sourceIn('source')),
  ],
);

export const orgUnits = pgTable(
  'org_units',
  {
    uuid: uuid('uuid').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    parentUuid: uuid('parent_uuid').references((): AnyPgColumn => orgUnits.uuid, {
      onDelete: 'restrict',
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
  (t) => [
    primaryKey({ columns: [t.directoryUserUuid, t.orgUnitUuid] }),
    // The primary key leads with directory_user_uuid; this serves member counts and the
    // ON DELETE CASCADE scan from org_units.
    index('org_unit_members_org_unit_idx').on(t.orgUnitUuid),
  ],
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
    // The unique constraint above already leads with directory_user_uuid (user lookups).
    // This one covers scope lookups and the ON DELETE CASCADE scan from org_units.
    index('role_assignments_scope_idx').on(t.scopeOrgUnitUuid),
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

// Catalogue of the roles and groups that may be stored for a user and targeted by a
// shared prompt. Filled from the Rollekatalog or from the `catalogue` section of
// AUTH_CONFIG_FILE (source 'config'); an IdP value that is not in here is never stored.
export const externalRoles = pgTable(
  'external_roles',
  {
    kind: text('kind').notNull(),
    identifier: text('identifier').notNull(),
    name: text('name').notNull(),
    source: text('source').notNull(),
    // Inactive = withdrawn from the catalogue: not stored for logins, not offered for targeting.
    active: boolean('active').notNull().default(true),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.identifier] }),
    check('external_roles_kind_check', sql`${t.kind} in ('role', 'group')`),
    check('external_roles_source_check', sql`${t.source} in ('rollekatalog', 'config', 'claims')`),
    check('external_roles_identifier_check', sql`char_length(${t.identifier}) between 1 and 200`),
    check('external_roles_name_check', sql`char_length(${t.name}) between 1 and 200`),
  ],
);

// The catalogue roles/groups an app user's IdP claimed at their latest login (replaced at
// every claims login in one transaction). The composite FK is the privacy guarantee: a
// value that is not in external_roles cannot be stored here at all.
export const userExternalRoles = pgTable(
  'user_external_roles',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    identifier: text('identifier').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind, t.identifier] }),
    foreignKey({
      columns: [t.kind, t.identifier],
      foreignColumns: [externalRoles.kind, externalRoles.identifier],
      name: 'user_external_roles_role_fk',
    }).onDelete('cascade'),
    index('user_external_roles_role_idx').on(t.kind, t.identifier),
  ],
);

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

/**
 * One-shot system flags (public schema). Today only 'bootstrap_admin_done': set
 * in the same transaction as the first-administrator grant (src/lib/authz/bootstrap.ts),
 * so BOOTSTRAP_ADMIN_EMAILS can create an administrator exactly once and does not
 * re-arm every time the last admin is removed. Recovery for an operator who locked
 * everyone out: `DELETE FROM system_flags WHERE key = 'bootstrap_admin_done';`
 * (or insert a role_assignments row by SQL).
 */
export const systemFlags = pgTable('system_flags', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull().default({}),
  setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Audit log (public schema, append-only) ────────────────────────────────
// Activity METADATA only: opaque entity ids and short codes, never content.
// actor_user_id and actor_org_unit_uuid deliberately have NO foreign key so rows
// survive user and org-unit deletion. The immutability triggers are hand-appended
// to drizzle/0002_audit_events.sql (drizzle-kit cannot express them).

export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull(),
    eventType: text('event_type').notNull(),
    outcome: text('outcome').notNull(),
    actorUserId: text('actor_user_id'),
    actorName: text('actor_name'),
    actorOrgUnitUuid: uuid('actor_org_unit_uuid'),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    secondaryEntityType: text('secondary_entity_type'),
    secondaryEntityId: text('secondary_entity_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    details: jsonb('details').notNull().default({}),
    clientEventId: uuid('client_event_id'),
    clientOccurredAt: timestamp('client_occurred_at', { withTimezone: true }),
  },
  (t) => [
    index('audit_events_occurred_at_idx').on(t.occurredAt),
    index('audit_events_actor_idx').on(t.actorUserId, t.id),
    index('audit_events_event_type_idx').on(t.eventType, t.id),
    // The viewer filters `(entity_id = $n OR secondary_entity_id = $n)`; one partial index per
    // column lets the planner use a BitmapOr over both.
    index('audit_events_entity_id_idx')
      .on(t.entityId)
      .where(sql`${t.entityId} is not null`),
    index('audit_events_secondary_entity_id_idx')
      .on(t.secondaryEntityId)
      .where(sql`${t.secondaryEntityId} is not null`),
    index('audit_events_org_unit_idx').on(t.actorOrgUnitUuid, t.id),
    // Idempotent client delivery: a retried batch cannot insert the same event twice.
    uniqueIndex('audit_events_client_event_unique')
      .on(t.actorUserId, t.clientEventId)
      .where(sql`${t.clientEventId} is not null`),
    check('audit_events_source_check', sql`${t.source} in ('server', 'client', 'system')`),
    check('audit_events_outcome_check', sql`${t.outcome} in ('success', 'denied', 'error')`),
  ],
);

// ─── Central templates (public schema) ─────────────────────────────────────
// Locked prompts a super user (template.manage, scoped to org units) delegates
// to the people beneath an org unit. central_template_versions is the changelog:
// append-only (immutability trigger hand-appended to
// drizzle/0003_central_templates.sql, drizzle-kit cannot express it). The
// *_user_id columns have NO foreign key so history survives user deletion.

// Postgres ARE bracket expression, as a SQL string literal (standard_conforming_strings is on),
// of the characters that do not count towards the name / change-note minimum: whitespace and
// invisible characters. It is the union of the app rule in skabeloner/change-note.ts
// (\p{Default_Ignorable_Code_Point}, Cc, Cf, the blank letters U+115F, U+1160, U+2800, U+3164,
// U+FFA0) and Unicode White_Space. Explicit \u / \U escapes and no POSIX class keep it independent
// of the database locale. GENERATED from those two JS regexes (see change-note.test.ts, which
// recomputes it and fails on any drift; regenerate after a Unicode data change). The app stays the
// first gate. The same literal is written out in drizzle/0003_central_templates.sql and its
// snapshot; keep them in sync. Exported for that test.
export const MEANINGLESS_CHARS_CLASS =
  String.raw`'[\u0001-\u0020\u007F-\u00A0\u00AD\u034F\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u115F\u1160\u1680\u17B4\u17B5\u180B-\u180F\u2000-\u200F\u2028-\u202F\u205F-\u206F\u2800\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0000-\U000E0FFF]'`;

export const centralTemplates = pgTable(
  'central_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // RESTRICT: an org unit that owns a central template cannot be deleted. NULL = an
    // ORGANISATION-WIDE template (claims mode has no org units): only a manager with a GLOBAL
    // template.manage assignment may touch it, and a scoped manager never sees it.
    ownerOrgUnitUuid: uuid('owner_org_unit_uuid').references(() => orgUnits.uuid, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    prompt: text('prompt').notNull(),
    includeDeltagere: boolean('include_deltagere').notNull().default(false),
    includeBeslutningspunkter: boolean('include_beslutningspunkter').notNull().default(false),
    includeDagsorden: boolean('include_dagsorden').notNull().default(false),
    includeDato: boolean('include_dato').notNull().default(false),
    allowUserInstruction: boolean('allow_user_instruction').notNull().default(false),
    allowToggleOverrides: boolean('allow_toggle_overrides').notNull().default(false),
    status: text('status').notNull().default('active'),
    currentVersion: integer('current_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('central_templates_owner_idx').on(t.ownerOrgUnitUuid),
    check('central_templates_status_check', sql`${t.status} in ('active', 'archived')`),
    check(
      'central_templates_name_check',
      sql`char_length(regexp_replace(${t.name}, ${sql.raw(MEANINGLESS_CHARS_CLASS)}, '', 'g')) >= 1 and char_length(${t.name}) <= 120`,
    ),
    check('central_templates_description_check', sql`char_length(${t.description}) <= 1000`),
    check('central_templates_prompt_check', sql`btrim(${t.prompt}) <> '' and char_length(${t.prompt}) <= 20000`),
    check('central_templates_version_check', sql`${t.currentVersion} >= 1`),
  ],
);

export const centralTemplateVersions = pgTable(
  'central_template_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => centralTemplates.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    changeType: text('change_type').notNull(),
    changeNote: text('change_note').notNull(),
    changedByUserId: text('changed_by_user_id'),
    // Name as it was when the change was made (the user may be renamed or deleted later).
    changedByName: text('changed_by_name'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    // Snapshot of ALL content fields and of the targets at this version.
    content: jsonb('content').notNull(),
    targets: jsonb('targets').notNull(),
    // The role/group targets at this version: [{kind, identifier, name}] (name as it was then).
    principalTargets: jsonb('principal_targets').notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [
    unique('central_template_versions_template_version_unique').on(t.templateId, t.version),
    check('central_template_versions_version_check', sql`${t.version} >= 1`),
    check(
      'central_template_versions_change_type_check',
      sql`${t.changeType} in ('create', 'update', 'retarget', 'archive', 'restore')`,
    ),
    check(
      'central_template_versions_change_note_check',
      sql`char_length(regexp_replace(${t.changeNote}, ${sql.raw(MEANINGLESS_CHARS_CLASS)}, '', 'g')) >= 10 and char_length(${t.changeNote}) <= 2000`,
    ),
  ],
);

export const centralTemplateTargets = pgTable(
  'central_template_targets',
  {
    templateId: uuid('template_id')
      .notNull()
      .references(() => centralTemplates.id, { onDelete: 'cascade' }),
    orgUnitUuid: uuid('org_unit_uuid')
      .notNull()
      .references(() => orgUnits.uuid, { onDelete: 'cascade' }),
    includeDescendants: boolean('include_descendants').notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.templateId, t.orgUnitUuid] }),
    index('central_template_targets_org_unit_idx').on(t.orgUnitUuid),
  ],
);

// The roles and groups a template is made available to (global managers only). The composite FK
// to the catalogue is RESTRICT: a catalogue entry that a template still targets is never
// deleted (a refresh only deactivates it), so a target cannot silently disappear.
export const centralTemplatePrincipalTargets = pgTable(
  'central_template_principal_targets',
  {
    templateId: uuid('template_id')
      .notNull()
      .references(() => centralTemplates.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    identifier: text('identifier').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.templateId, t.kind, t.identifier] }),
    foreignKey({
      columns: [t.kind, t.identifier],
      foreignColumns: [externalRoles.kind, externalRoles.identifier],
      name: 'central_template_principal_targets_role_fk',
    }).onDelete('restrict'),
    index('central_template_principal_targets_role_idx').on(t.kind, t.identifier),
  ],
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

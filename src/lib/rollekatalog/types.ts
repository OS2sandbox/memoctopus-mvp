// Shared Rollekatalog types and pure helpers: no I/O, no server imports.
import type { RoleKey } from '@/lib/authz/types';

// ─── Sync ──────────────────────────────────────────────────────────────────

/** Counters of one sync run. Stored in sync_runs.counts; only counts, never data. */
export interface SyncCounts {
  usersUpserted: number;
  /** Mirrored users missing from the fetch (and so disabled), plus users disabled in Rollekatalog. */
  usersDisabled: number;
  /** better-auth sessions deleted because their linked directory user is disabled (a count, never who). */
  sessionsRevoked: number;
  orgUnitsUpserted: number;
  /** Units stored with parent_uuid NULL because the parent was not in the fetch. */
  orgUnitsOrphaned: number;
  /** Parent links dropped to break a cycle in the fetched data. */
  orgUnitCyclesBroken: number;
  assignmentsUpserted: number;
  assignmentsRemoved: number;
  /** Assignments whose roleIdentifier is not one of our four roles. */
  assignmentsIgnoredRole: number;
  /** Assignments for a user that is not in the mirror. */
  assignmentsSkippedUnknownUser: number;
  /** Role assignments that yielded no scope and may not be global (fail closed, no row). */
  assignmentsWithoutScope: number;
  /** User rows dropped because they failed validation (e.g. a uuid that is not a uuid); they are simply absent from the fetch. */
  usersSkippedInvalid: number;
  /** Org unit rows dropped because they failed validation; their children become roots. */
  orgUnitsSkippedInvalid: number;
  /** Role-assignment rows, and assignment entries inside valid rows, dropped because they failed validation. */
  assignmentRowsSkippedInvalid: number;
  /** Position entries of a user dropped for a wrong shape (the user itself is kept). */
  membershipsSkippedInvalid: number;
}

export const SYNC_COUNT_KEYS = [
  'usersUpserted',
  'usersDisabled',
  'sessionsRevoked',
  'orgUnitsUpserted',
  'orgUnitsOrphaned',
  'orgUnitCyclesBroken',
  'assignmentsUpserted',
  'assignmentsRemoved',
  'assignmentsIgnoredRole',
  'assignmentsSkippedUnknownUser',
  'assignmentsWithoutScope',
  'usersSkippedInvalid',
  'orgUnitsSkippedInvalid',
  'assignmentRowsSkippedInvalid',
  'membershipsSkippedInvalid',
] as const satisfies ReadonlyArray<keyof SyncCounts>;

export function emptySyncCounts(): SyncCounts {
  return Object.fromEntries(SYNC_COUNT_KEYS.map((k) => [k, 0])) as unknown as SyncCounts;
}

/**
 * success = applied; aborted = a safety guard stopped it before any write
 * (empty_response, removal_threshold; too many invalid rows is invalid_response and also aborts before any write); error = fetch/apply failed and the mirror is
 * unchanged; already_running = another run holds the advisory lock (no sync_runs row).
 * In sync_runs.status (CHECK 'running'|'success'|'failed') both 'aborted' and 'error' are stored as 'failed'.
 */
export type SyncStatus = 'success' | 'aborted' | 'error' | 'already_running';

export interface SyncResult {
  status: SyncStatus;
  /** The sync_runs row id; null for already_running. */
  runId: string | null;
  counts: SyncCounts;
  /** A RollekatalogErrorCode, 'empty_response', 'removal_threshold', 'not_configured', 'unexpected', ...; null on success. */
  errorCode: string | null;
}

export interface SyncRunSummary {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  /** The stored sync_runs.status. */
  status: 'running' | 'success' | 'failed';
  counts: SyncCounts | null;
  errorCode: string | null;
}

export interface RunSyncOptions {
  trigger: 'cron' | 'manual';
  /** Bypass the removal threshold (admin button; the route requires sync.run). The empty-response guard still applies. */
  force?: boolean;
  /** The admin for a manual run (audit actor); null/absent for cron. */
  actorUserId?: string | null;
}

// ─── Scope derivation (pure) ───────────────────────────────────────────────

/** Constraint type entityIds that carry org-unit uuids (taken from the OS2rollekatalog 2026r4 source, not seen on a live instance; see docs/central-access/rollekatalog.md). */
export const ORG_UNIT_CONSTRAINT_TYPES: readonly string[] = [
  'http://digital-identity.dk/constraints/orgunit/1',
  'http://sts.kombit.dk/constraints/orgenhed/1',
];

export function isOrgUnitConstraintType(entityId: string): boolean {
  return ORG_UNIT_CONSTRAINT_TYPES.includes(entityId.trim());
}

/** One resolved constraint of an assignment, as the schemas deliver it. */
export interface ScopeConstraint {
  constraintType: string;
  constraintValues: readonly string[];
}

export interface ScopeInput {
  roleKey: RoleKey;
  /** All constraint values of the (user, role) assignment(s); duplicate role entries already concatenated. */
  constraints: readonly ScopeConstraint[];
  /**
   * The assignment(s) also carried a non-empty constraint of a type we do not recognise
   * (the schemas drop such types at parse time and keep only this flag). scope.ts also
   * derives it from any non-org-unit entry in `constraints`.
   */
  hasUnrecognisedConstraints?: boolean;
  /** Lower-case uuids of every org unit in the mirror; unknown constraint units are ignored. */
  knownOrgUnitUuids: ReadonlySet<string>;
  /** ROLLEKATALOG_GLOBAL_ROLES. */
  globalRoles: readonly RoleKey[];
  /** ROLLEKATALOG_SCOPE_DESCENDANTS. */
  includeDescendants: boolean;
}

/**
 * none = no role_assignments row (fail closed); global = one row with a NULL scope;
 * scoped = one row per unit.
 */
export type DerivedScope =
  | { kind: 'none' }
  | { kind: 'global' }
  | { kind: 'scoped'; orgUnitUuids: string[]; includeDescendants: boolean };

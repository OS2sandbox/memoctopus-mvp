// The BINDING contract between the Rollekatalog tracks (client/schemas, scope
// derivation, sync, login refresh, routes). Types and one pure helper only: no
// I/O, no imports of server code, so every track and every test can use it.
import type { RoleKey } from '@/lib/authz/types';
import type { ScopeStrategy } from './config';

export type { ScopeStrategy } from './config';

// ─── Sync ──────────────────────────────────────────────────────────────────

/** Counters of one sync run. Stored in sync_runs.counts; only counts, never data. */
export interface SyncCounts {
  usersUpserted: number;
  /** Mirrored users missing from the fetch (and so disabled), plus users disabled in Rollekatalog. */
  usersDisabled: number;
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
}

export const SYNC_COUNT_KEYS = [
  'usersUpserted',
  'usersDisabled',
  'orgUnitsUpserted',
  'orgUnitsOrphaned',
  'orgUnitCyclesBroken',
  'assignmentsUpserted',
  'assignmentsRemoved',
  'assignmentsIgnoredRole',
  'assignmentsSkippedUnknownUser',
  'assignmentsWithoutScope',
] as const satisfies ReadonlyArray<keyof SyncCounts>;

export function emptySyncCounts(): SyncCounts {
  return {
    usersUpserted: 0,
    usersDisabled: 0,
    orgUnitsUpserted: 0,
    orgUnitsOrphaned: 0,
    orgUnitCyclesBroken: 0,
    assignmentsUpserted: 0,
    assignmentsRemoved: 0,
    assignmentsIgnoredRole: 0,
    assignmentsSkippedUnknownUser: 0,
    assignmentsWithoutScope: 0,
  };
}

/**
 * success = applied; aborted = a safety guard stopped it before any write
 * (empty_response, removal_threshold); error = fetch/apply failed and the mirror is
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

/** Implemented by the sync track in src/lib/rollekatalog/sync.ts. Never throws: failures are a SyncResult. */
export type RunSync = (opts: RunSyncOptions) => Promise<SyncResult>;
/** Implemented by the sync track in src/lib/rollekatalog/sync.ts. */
export type GetLatestSyncRun = () => Promise<SyncRunSummary | null>;

// ─── Scope derivation (pure) ───────────────────────────────────────────────

/** Constraint type entityIds that carry org-unit uuids (verified, phase0-findings Q1). */
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
  strategy: ScopeStrategy;
  roleKey: RoleKey;
  /** All constraint values of the (user, role) assignment(s); duplicate role entries already concatenated. */
  constraints: readonly ScopeConstraint[];
  /** Lower-case uuids of every org unit in the mirror; unknown constraint units are ignored. */
  knownOrgUnitUuids: ReadonlySet<string>;
  /** Lower-case uuids of the units the user manages or substitutes for. */
  managedOrgUnitUuids: readonly string[];
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

/** The signature of the pure derivation, implemented by the scope track. */
export type DeriveScope = (input: ScopeInput) => DerivedScope;

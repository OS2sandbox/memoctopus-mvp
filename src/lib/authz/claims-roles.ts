// ACCESS_SOURCE=claims: turns the role/group claims of one SSO login into the user's
// role rows. Rights are managed OUTSIDE this app (in the IdP, or upstream of it in
// something like OS2rollekatalog) and sent along at login; this module only reads them.
//
// At every login, in ONE transaction, the user's source='claims' role_assignments are
// REPLACED by what the claims say now (so a removed role drops), and so are their
// user_external_roles. A claim that cannot be parsed keeps nothing (the rows are
// deleted): fail closed. Unknown values are ignored; only values listed in the
// `roles` mapping can grant a role and only values in the catalogue (external_roles)
// are ever stored. Claim values are never logged and never put in the audit log.
import { authRolesConfig, providerClaimSpecs, type ClaimListSpec, type RolesConfig } from '@/lib/auth/providers';
import { accessSource } from './config';
import { defaultRunner, errorLabel, type SqlQueryable, type SqlRunner } from './pg-runner';
import type { RoleKey } from './types';

export type ClaimValues =
  | { status: 'unconfigured' }
  | { status: 'invalid' }
  | { status: 'ok'; values: string[] };

const MAX_VALUES = 1000;
const MAX_VALUE_LENGTH = 512;

/** An own property of a plain object, never an inherited one (`__proto__`, `constructor`, ...). */
function own(obj: unknown, key: string): { found: boolean; value?: unknown } {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj) && Object.hasOwn(obj, key)) {
    return { found: true, value: (obj as Record<string, unknown>)[key] };
  }
  return { found: false };
}

/**
 * The value of a claim: the exact key first (SAML attribute names are often URLs full of
 * dots), then, if the name contains dots, a path through nested objects (Keycloak's
 * `realm_access.roles`). undefined when absent.
 */
export function readClaim(claims: Record<string, unknown>, name: string): unknown {
  const exact = own(claims, name);
  if (exact.found) return exact.value;
  if (!name.includes('.')) return undefined;
  let cur: unknown = claims;
  for (const part of name.split('.')) {
    const next = own(cur, part);
    if (!next.found) return undefined;
    cur = next.value;
  }
  return cur;
}

/**
 * Reads one role/group claim as a list of values. A claim that is absent is "no values"
 * (the person has none); one that has the wrong shape is invalid, and the caller keeps
 * nothing for it. Values are trimmed, deduplicated, and must be short non-empty strings.
 */
export function extractClaimValues(claims: Record<string, unknown>, spec: ClaimListSpec | undefined): ClaimValues {
  if (!spec) return { status: 'unconfigured' };
  const raw = readClaim(claims, spec.name);
  if (raw === undefined || raw === null) return { status: 'ok', values: [] };

  let list: unknown[];
  if (spec.format === 'delimited') {
    if (typeof raw !== 'string') return { status: 'invalid' };
    list = raw.split(spec.separator);
  } else if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string') {
    list = [raw]; // a single value is often sent as a bare string
  } else {
    return { status: 'invalid' };
  }
  if (list.length > MAX_VALUES) return { status: 'invalid' };

  const values = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') return { status: 'invalid' };
    const v = item.trim();
    if (v === '') continue;
    if (v.length > MAX_VALUE_LENGTH) return { status: 'invalid' };
    values.add(v);
  }
  return { status: 'ok', values: [...values] };
}

/**
 * Keeps only the claims that the provider's role/group specs read (the top-level key, for a
 * dotted path), so a short-lived in-memory hand-over never holds the rest of a profile.
 */
export function claimSubset(
  claims: Record<string, unknown>,
  specs: { rolesClaim?: ClaimListSpec; groupsClaim?: ClaimListSpec },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of [specs.rolesClaim, specs.groupsClaim]) {
    if (!spec) continue;
    for (const key of [spec.name, spec.name.split('.')[0]]) {
      const hit = own(claims, key);
      if (hit.found) {
        out[key] = hit.value;
        break;
      }
    }
  }
  return out;
}

/** Roles that the mapping grants for these claim values. Unknown values grant nothing. */
export function mapClaimRoles(values: readonly string[], map: ReadonlyMap<string, { role: RoleKey }>): RoleKey[] {
  const roles = new Set<RoleKey>();
  for (const v of values) {
    const hit = map.get(v);
    if (hit) roles.add(hit.role);
  }
  return [...roles];
}

export interface ClaimsDecision {
  /** Roles to hold after this login (global grants). */
  roles: RoleKey[];
  /** Role/group values the IdP claimed, to be filtered through the catalogue. */
  external: Array<{ kind: 'role' | 'group'; identifier: string }>;
}

/**
 * Pure: what one login's claims mean. Fails closed at every turn: no claims, an unusable
 * `roles` section, an unknown provider or a malformed claim all give "nothing".
 */
export function decideFromClaims(
  claims: Record<string, unknown> | null,
  providerId: string,
  rolesConfig: RolesConfig = authRolesConfig(),
  specs = providerClaimSpecs(providerId),
): ClaimsDecision {
  const none: ClaimsDecision = { roles: [], external: [] };
  if (!claims || !specs) return none;

  const roleValues = extractClaimValues(claims, specs.rolesClaim);
  const groupValues = extractClaimValues(claims, specs.groupsClaim);
  // One malformed claim poisons the whole login: half of an IdP's statement is not safe to act on.
  if (roleValues.status === 'invalid' || groupValues.status === 'invalid') return none;

  const roles = new Set<RoleKey>();
  if (rolesConfig.state === 'ok') {
    if (roleValues.status === 'ok') mapClaimRoles(roleValues.values, rolesConfig.appRoleMap).forEach((r) => roles.add(r));
    if (groupValues.status === 'ok') mapClaimRoles(groupValues.values, rolesConfig.groupRoleMap).forEach((r) => roles.add(r));
  }

  const external: ClaimsDecision['external'] = [];
  if (roleValues.status === 'ok') roleValues.values.forEach((identifier) => external.push({ kind: 'role', identifier }));
  if (groupValues.status === 'ok') groupValues.values.forEach((identifier) => external.push({ kind: 'group', identifier }));
  return { roles: [...roles], external };
}

interface ApplyResult {
  outcome: 'applied' | 'skipped_not_claims_mode' | 'skipped_disabled';
  /** Counts only. */
  rolesWritten: number;
  externalStored: number;
}

/**
 * Finds the user's directory row, creating one (source 'claims') on the first claims
 * login. Null when the person is disabled. Locks the row for the rest of the transaction
 * so two concurrent logins of one person serialise.
 */
async function lockDirectoryUser(tx: SqlQueryable, userId: string): Promise<string | null> {
  const find = () =>
    tx.query<{ uuid: string; disabled: boolean }>(
      'SELECT uuid, disabled FROM public.directory_users WHERE app_user_id = $1 FOR UPDATE',
      [userId],
    );
  let row = (await find()).rows[0];
  if (!row) {
    // ON CONFLICT: a concurrent login created the row between our SELECT and INSERT.
    await tx.query(
      `INSERT INTO public.directory_users (name, email, source, app_user_id)
       SELECT name, email, 'claims', id FROM public.users WHERE id = $1
       ON CONFLICT (app_user_id) DO NOTHING`,
      [userId],
    );
    row = (await find()).rows[0];
  }
  if (!row) throw new Error('claims: app user vanished');
  return row.disabled ? null : row.uuid;
}

async function replaceExternalRoles(
  tx: SqlQueryable,
  userId: string,
  external: ClaimsDecision['external'],
): Promise<number> {
  await tx.query('DELETE FROM public.user_external_roles WHERE user_id = $1', [userId]);
  if (external.length === 0) return 0;
  // Only values that are in the (active) catalogue are stored; the composite FK enforces the
  // same thing for any other writer.
  const stored = await tx.query(
    `INSERT INTO public.user_external_roles (user_id, kind, identifier, seen_at)
     SELECT $1, e.kind, e.identifier, now()
       FROM public.external_roles e
       JOIN unnest($2::text[], $3::text[]) AS c(kind, identifier)
         ON c.kind = e.kind AND c.identifier = e.identifier
      WHERE e.active
     RETURNING 1`,
    [userId, external.map((e) => e.kind), external.map((e) => e.identifier)],
  );
  return stored.rows.length;
}

/**
 * Replaces the user's claims-sourced role rows and external role/group rows with what this
 * login's claims decide. `claims` null means "the IdP told us nothing usable": everything
 * is cleared. No-op outside ACCESS_SOURCE=claims. Throws on a database error; the login
 * hook owns the swallow-and-log policy (and clears on failure).
 */
export async function applyClaimsLogin(
  input: { userId: string; providerId: string; claims: Record<string, unknown> | null },
  runner: SqlRunner = defaultRunner(),
): Promise<ApplyResult> {
  if (accessSource() !== 'claims') return { outcome: 'skipped_not_claims_mode', rolesWritten: 0, externalStored: 0 };
  const decision = decideFromClaims(input.claims, input.providerId);

  return runner.transaction(async (tx) => {
    const directoryUuid = await lockDirectoryUser(tx, input.userId);
    if (directoryUuid === null) {
      // A disabled person is refused everywhere; make sure no claim role is left behind either.
      await clearTx(tx, input.userId);
      return { outcome: 'skipped_disabled' as const, rolesWritten: 0, externalStored: 0 };
    }
    await tx.query(`DELETE FROM public.role_assignments WHERE directory_user_uuid = $1 AND source = 'claims'`, [
      directoryUuid,
    ]);
    for (const role of decision.roles) {
      await tx.query(
        `INSERT INTO public.role_assignments
           (directory_user_uuid, role_key, scope_org_unit_uuid, include_descendants, source, synced_at, created_by_user_id)
         VALUES ($1, $2, NULL, true, 'claims', now(), NULL)`,
        [directoryUuid, role],
      );
    }
    const externalStored = await replaceExternalRoles(tx, input.userId, decision.external);
    return { outcome: 'applied' as const, rolesWritten: decision.roles.length, externalStored };
  });
}

async function clearTx(tx: SqlQueryable, userId: string): Promise<void> {
  await tx.query(
    `DELETE FROM public.role_assignments ra USING public.directory_users du
      WHERE ra.directory_user_uuid = du.uuid AND du.app_user_id = $1 AND ra.source = 'claims'`,
    [userId],
  );
  await tx.query('DELETE FROM public.user_external_roles WHERE user_id = $1', [userId]);
}

/**
 * Removes everything claims gave this user. Used when a session starts without IdP claims
 * (a password sign-in must never inherit the roles of an earlier SSO login) and after a
 * failed apply (fail closed). Safe in every mode.
 */
export async function clearClaimsRoles(userId: string, runner: SqlRunner = defaultRunner()): Promise<void> {
  await runner.transaction((tx) => clearTx(tx, userId));
}

/** applyClaimsLogin that never throws: on any error it logs a label and best-effort clears (fail closed). */
export async function applyClaimsLoginSafely(
  input: { userId: string; providerId: string; claims: Record<string, unknown> | null },
  runner: SqlRunner = defaultRunner(),
): Promise<void> {
  try {
    await applyClaimsLogin(input, runner);
  } catch (err) {
    console.error(`[authz] login step failed: apply_claims (${errorLabel(err)})`);
    try {
      await clearClaimsRoles(input.userId, runner);
    } catch (clearErr) {
      console.error(`[authz] login step failed: clear_claims (${errorLabel(clearErr)})`);
    }
  }
}

// WHITELIST schemas for the Rollekatalog responses we consume. Every object is
// `.strip()`ped, so a field we do not name here can never enter our types. That is
// the privacy boundary: the organisation v3 user DTO also carries cpr, nemloginUuid,
// phone and KLE lists, none of which are needed and none of which may survive
// parsing. Adding a field here is a privacy decision, not a convenience.
//
// Shapes are from the OS2rollekatalog 2026r4 source; optional and null fields are tolerated
// where the DTOs can produce them (e.g. `positions: null`).
//
// ROW-BY-ROW PARSING. Rollekatalog's own user/unit uuid is a free varchar(36) supplied
// by the importing system, so one legacy row with a non-uuid id must not fail a 50,000
// user answer. The arrays are therefore validated row by row: a row that fails its
// whitelist schema is DROPPED and COUNTED (never stored, never logged with content).
// Payload-level shape errors (not an object, missing/non-array users or orgUnits) still
// fail the whole payload as invalid_response. A guard keeps this from hiding a broken
// export: more than `invalidRowAllowance(total)` bad rows in one array also fails the
// payload as invalid_response, before anything is written.
import { z } from 'zod';
import { RollekatalogError } from './errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const lower = (s: string) => s.trim().toLowerCase();

/** A uuid, normalised to lower case. Anything else is a malformed payload. */
const uuidStr = z
  .string()
  .trim()
  .regex(UUID_RE)
  .transform(lower);

/** Optional uuid: absent, null or NOT a uuid all become null (e.g. an AD-style extUuid; the row is then keyed on `uuid`). */
const lenientUuid = z
  .unknown()
  .transform((v) => (typeof v === 'string' && UUID_RE.test(v.trim()) ? lower(v) : null));

// ─── invalid-row tolerance ─────────────────────────────────────────────────

/** Bad rows always tolerated per array, however small the array. */
export const INVALID_ROWS_MIN_ALLOWANCE = 3;
/** Bad rows tolerated as a percentage of the rows of one array (whichever of the two allowances is larger applies). */
export const INVALID_ROWS_MAX_PERCENT = 5;

/** How many bad rows an array of `total` rows may contain: max(3, 5 % of total, rounded down). */
export function invalidRowAllowance(total: number): number {
  return Math.max(INVALID_ROWS_MIN_ALLOWANCE, Math.floor((total * INVALID_ROWS_MAX_PERCENT) / 100));
}

/**
 * Fails the payload (a zod issue, which parseOrThrow turns into invalid_response) when
 * `bad` exceeds the allowance of an array of `total` rows. Nothing is logged here: the client
 * never logs, and the run records the short code only.
 */
function guardInvalidRows(bad: number, total: number, ctx: z.RefinementCtx): void {
  const allowance = invalidRowAllowance(total);
  if (bad <= allowance) return;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'too many invalid rows' });
}

/** Optional string: absent, null or blank all become null. */
const optStr = z
  .string()
  .nullish()
  .transform((v) => {
    const t = v?.trim();
    return t ? t : null;
  });

// ─── organisation v3 ───────────────────────────────────────────────────────

const positionSchema = z
  .object({
    orgUnitUuid: lenientUuid,
    titleUuid: optStr,
    doNotInherit: z.boolean().nullish().transform((v) => v === true),
  })
  .strip();

// `positions` stays raw here: each entry is validated on its own, so one broken position
// costs that position only, never the user.
const orgUserRowSchema = z
  .object({
    uuid: uuidStr,
    extUuid: lenientUuid,
    userId: optStr,
    name: optStr,
    email: optStr,
    // Required on purpose: a missing flag must not be read as "enabled".
    disabled: z.boolean(),
    positions: z.array(z.unknown()).nullish(),
  })
  .strip();

const orgUnitSchema = z
  .object({
    uuid: uuidStr,
    name: z.string(),
    parentOrgUnitUuid: lenientUuid,
  })
  .strip();

export interface RkPosition {
  orgUnitUuid: string;
  titleUuid: string | null;
  doNotInherit: boolean;
}

export interface RkUser {
  uuid: string;
  extUuid: string | null;
  userId: string | null;
  name: string;
  email: string | null;
  disabled: boolean;
  positions: RkPosition[];
}

export type RkOrgUnit = z.output<typeof orgUnitSchema>;

/** Rows that were dropped for failing their schema. Counts only. */
export interface RkOrganisationSkipped {
  /** User rows that failed validation (e.g. a uuid that is not a uuid). The user is absent from the fetch. */
  users: number;
  orgUnits: number;
  /**
   * Position entries with a wrong SHAPE (not an object, wrong field types). A position
   * whose orgUnitUuid is merely not a uuid is dropped quietly instead: that unit is itself
   * a skipped unit, so it is already counted under `orgUnits`.
   */
  positions: number;
}

export interface RkOrganisation {
  users: RkUser[];
  orgUnits: RkOrgUnit[];
  skipped: RkOrganisationSkipped;
}

function toUser(row: z.output<typeof orgUserRowSchema>): { user: RkUser; skippedPositions: number } {
  const positions: RkPosition[] = [];
  let skippedPositions = 0;
  for (const raw of row.positions ?? []) {
    const p = positionSchema.safeParse(raw);
    if (!p.success) {
      skippedPositions++;
      continue;
    }
    // A position without a (valid) unit says nothing about membership.
    if (p.data.orgUnitUuid) {
      positions.push({ orgUnitUuid: p.data.orgUnitUuid, titleUuid: p.data.titleUuid, doNotInherit: p.data.doNotInherit });
    }
  }
  return {
    user: {
      uuid: row.uuid,
      extUuid: row.extUuid,
      userId: row.userId,
      name: row.name ?? row.userId ?? row.uuid,
      email: row.email,
      disabled: row.disabled,
      positions,
    },
    skippedPositions,
  };
}

export const organisationSchema = z
  .object({
    users: z.array(z.unknown()),
    orgUnits: z.array(z.unknown()),
  })
  .strip()
  .transform((raw, ctx): RkOrganisation => {
    const users: RkUser[] = [];
    let skippedUsers = 0;
    let skippedPositions = 0;
    for (const row of raw.users) {
      const parsed = orgUserRowSchema.safeParse(row);
      if (!parsed.success) {
        skippedUsers++;
        continue;
      }
      const { user, skippedPositions: sp } = toUser(parsed.data);
      skippedPositions += sp;
      users.push(user);
    }

    const orgUnits: RkOrgUnit[] = [];
    let skippedUnits = 0;
    for (const row of raw.orgUnits) {
      const parsed = orgUnitSchema.safeParse(row);
      if (parsed.success) orgUnits.push(parsed.data);
      else skippedUnits++;
    }

    guardInvalidRows(skippedUsers, raw.users.length, ctx);
    guardInvalidRows(skippedUnits, raw.orgUnits.length, ctx);
    return { users, orgUnits, skipped: { users: skippedUsers, orgUnits: skippedUnits, positions: skippedPositions } };
  });

// ─── role assignments with constraints ─────────────────────────────────────

const constraintValueSchema = z
  .object({
    // The constraint type's entityId (a URL), never its name or uuid.
    constraintType: z.string(),
    constraintValues: z
      .array(z.string())
      .nullish()
      .transform((v) => v ?? []),
  })
  .strip();

const assignmentSchema = z
  .object({
    roleIdentifier: z.string(),
    roleName: optStr,
    roleConstraintValues: z
      .array(constraintValueSchema)
      .nullish()
      .transform((v) => v ?? []),
  })
  .strip();

// `assignments` stays raw: each entry is validated on its own, so one broken entry costs
// that entry only (an entry is only ever dropped, never widened: fail closed).
const userAssignmentsRowSchema = z
  .object({
    extUuid: lenientUuid,
    userId: optStr,
    assignments: z.array(z.unknown()).nullish(),
  })
  .strip();

export interface RkUserAssignments {
  extUuid: string | null;
  userId: string | null;
  assignments: Array<z.output<typeof assignmentSchema>>;
}

export interface RkRoleAssignments {
  rows: RkUserAssignments[];
  /** Dropped rows plus dropped assignment entries inside valid rows. Counts only. */
  skipped: number;
}

export const roleAssignmentsSchema = z.array(z.unknown()).transform((raw, ctx): RkRoleAssignments => {
  const rows: RkUserAssignments[] = [];
  let skippedRows = 0;
  let skippedEntries = 0;
  let totalEntries = 0;
  for (const row of raw) {
    const parsed = userAssignmentsRowSchema.safeParse(row);
    if (!parsed.success) {
      skippedRows++;
      continue;
    }
    const assignments: RkUserAssignments['assignments'] = [];
    for (const entry of parsed.data.assignments ?? []) {
      totalEntries++;
      const a = assignmentSchema.safeParse(entry);
      if (a.success) assignments.push(a.data);
      else skippedEntries++;
    }
    rows.push({ extUuid: parsed.data.extUuid, userId: parsed.data.userId, assignments });
  }
  guardInvalidRows(skippedRows, raw.length, ctx);
  guardInvalidRows(skippedEntries, totalEntries, ctx);
  return { rows, skipped: skippedRows + skippedEntries };
});

/** Parses a response body; a mismatch is `invalid_response` and never echoes the data. */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const res = schema.safeParse(data);
  if (!res.success) throw new RollekatalogError('invalid_response');
  return res.data;
}

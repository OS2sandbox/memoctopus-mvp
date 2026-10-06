// WHITELIST schemas for the Rollekatalog responses we consume. Every object is
// `.strip()`ped, so a field we do not name here can never enter our types. That is
// the privacy boundary: the organisation v3 user DTO also carries cpr, nemloginUuid,
// phone and KLE lists, none of which are needed and none of which may survive
// parsing. Adding a field here is a privacy decision, not a convenience.
//
// Shapes are from the OS2rollekatalog 2026r4 source; optional and null fields are tolerated
// where the DTOs can produce them (e.g. `positions: null`).
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

const orgUserSchema = z
  .object({
    uuid: uuidStr,
    extUuid: lenientUuid,
    userId: optStr,
    name: optStr,
    email: optStr,
    // Required on purpose: a missing flag must not be read as "enabled".
    disabled: z.boolean(),
    positions: z.array(positionSchema).nullish(),
  })
  .strip()
  .transform((u) => ({
    uuid: u.uuid,
    extUuid: u.extUuid,
    userId: u.userId,
    name: u.name ?? u.userId ?? u.uuid,
    email: u.email,
    disabled: u.disabled,
    // A position without a unit says nothing about membership.
    positions: (u.positions ?? []).flatMap((p) =>
      p.orgUnitUuid ? [{ orgUnitUuid: p.orgUnitUuid, titleUuid: p.titleUuid, doNotInherit: p.doNotInherit }] : [],
    ),
  }));

const orgUnitSchema = z
  .object({
    uuid: uuidStr,
    name: z.string(),
    parentOrgUnitUuid: lenientUuid,
  })
  .strip();

export const organisationSchema = z
  .object({
    users: z.array(orgUserSchema),
    orgUnits: z.array(orgUnitSchema),
  })
  .strip();

export type RkOrganisation = z.output<typeof organisationSchema>;

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

const userAssignmentsSchema = z
  .object({
    extUuid: lenientUuid,
    userId: optStr,
    assignments: z
      .array(assignmentSchema)
      .nullish()
      .transform((v) => v ?? []),
  })
  .strip();

export const roleAssignmentsSchema = z.array(userAssignmentsSchema);
export type RkUserAssignments = z.output<typeof userAssignmentsSchema>;

/** Parses a response body; a mismatch is `invalid_response` and never echoes the data. */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const res = schema.safeParse(data);
  if (!res.success) throw new RollekatalogError('invalid_response');
  return res.data;
}

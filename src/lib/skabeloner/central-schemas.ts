import { z } from 'zod';
import { CENTRAL_LIMITS, PRINCIPAL_KINDS } from './central-types';
import { CHANGE_NOTE_MESSAGE, meaningfulLength, stripInvisible } from './change-note';

// Request bodies for the manager-side central template routes. Every object is
// strict: unknown keys are rejected, never silently ignored. Messages are
// Danish; the routes only echo issue paths and codes (access-http.ts), the
// service layer raises the same messages as ValidationError.

export { CHANGE_NOTE_MESSAGE };
export const NUL_MESSAGE = 'Teksten må ikke indeholde nul-tegn';
// Postgres text and jsonb cannot hold U+0000; left to the database it surfaces as a 500.
const noNul = (v: string) => !v.includes('\u0000');

// A lone surrogate (an unpaired half of a UTF-16 pair) cannot be encoded as UTF-8 JSON and
// Postgres jsonb rejects it (SQLSTATE 22P02). In u-mode a valid pair is one astral code point,
// so \p{Cs} only matches a lone half.
export const MALFORMED_MESSAGE = 'Teksten indeholder ugyldige tegn (ufuldstændigt Unicode-tegn)';
const wellFormed = (v: string) => !/\p{Cs}/u.test(v);

// Everything stored is NFC, so the same visible text always compares and counts the same.
const nfc = (v: string) => v.normalize('NFC');

const CHANGE_NOTE_TOO_LONG_MESSAGE = `Ændringsbeskrivelsen er for lang (højst ${CENTRAL_LIMITS.changeNoteMax} tegn)`;

// NUL is checked on the raw value (stripping it silently would hide it). The raw cap
// bounds the work of the strip. After stripping and trimming, only non-whitespace code
// points count towards the minimum, so a note of spaces or invisible characters does not
// pass. Code points, not UTF-16 units: 5 emoji are 10 units but 5 characters. The stored
// note is the normalised one (interior whitespace kept). The table CHECKs mirror this rule
// (counted meaningful characters) and must be kept in sync with MEANINGLESS_CHARS_CLASS in
// src/lib/db/schema.ts; this schema is the first gate and gives the friendly message.
export const changeNoteSchema = z
  .string({ required_error: CHANGE_NOTE_MESSAGE, invalid_type_error: CHANGE_NOTE_MESSAGE })
  .max(CENTRAL_LIMITS.changeNoteMax * 4, CHANGE_NOTE_TOO_LONG_MESSAGE)
  .refine(noNul, NUL_MESSAGE)
  .refine(wellFormed, MALFORMED_MESSAGE)
  .transform((v) => nfc(stripInvisible(v)))
  .pipe(
    z
      .string()
      .max(CENTRAL_LIMITS.changeNoteMax, CHANGE_NOTE_TOO_LONG_MESSAGE)
      .refine((v) => meaningfulLength(v) >= CENTRAL_LIMITS.changeNoteMin, CHANGE_NOTE_MESSAGE),
  );

const uuidSchema = z.string().uuid().transform((v) => v.toLowerCase());

const centralTargetSchema = z
  .object({
    orgUnitUuid: uuidSchema,
    includeDescendants: z.boolean().default(true),
  })
  .strict();

// The first entry for a unit wins; later duplicates are dropped. Order is kept.
export function dedupeTargets<T extends { orgUnitUuid: string }>(targets: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of targets) {
    const key = t.orgUnitUuid.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export const centralTargetsSchema = z
  .array(centralTargetSchema)
  .max(CENTRAL_LIMITS.targets, `Højst ${CENTRAL_LIMITS.targets} enheder`)
  .transform((targets) => dedupeTargets(targets));

// A role/group value of the catalogue. Compared exactly as the IdP sends it, so no case folding or
// normalisation: only trimmed, and rejected when it holds NUL, a lone surrogate or a control character.
const principalIdentifierSchema = z
  .string()
  .trim()
  .min(1, 'Rollen eller gruppen mangler en identifikator')
  .max(CENTRAL_LIMITS.principalIdentifier, 'Identifikatoren er for lang')
  .refine(noNul, NUL_MESSAGE)
  .refine(wellFormed, MALFORMED_MESSAGE)
  .refine((v) => !/\p{Cc}/u.test(v), 'Identifikatoren indeholder ugyldige tegn');

const centralPrincipalTargetSchema = z
  .object({ kind: z.enum(PRINCIPAL_KINDS), identifier: principalIdentifierSchema })
  .strict();

export function dedupePrincipalTargets<T extends { kind: string; identifier: string }>(targets: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of targets) {
    const key = `${t.kind}\u0000${t.identifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export const centralPrincipalTargetsSchema = z
  .array(centralPrincipalTargetSchema)
  .max(CENTRAL_LIMITS.principalTargets, `Højst ${CENTRAL_LIMITS.principalTargets} roller og grupper`)
  .transform((targets) => dedupePrincipalTargets(targets));

// NUL and lone surrogates are checked on the raw value, then invisible characters are
// stripped (so a name of only invisible characters is empty) and the text is made NFC.
const nameSchema = z
  .string()
  .max(CENTRAL_LIMITS.name * 4, `Navnet er for langt (højst ${CENTRAL_LIMITS.name} tegn)`)
  .refine(noNul, NUL_MESSAGE)
  .refine(wellFormed, MALFORMED_MESSAGE)
  .transform((v) => nfc(stripInvisible(v)))
  .pipe(
    z
      .string()
      .min(1, 'Navn er påkrævet')
      .max(CENTRAL_LIMITS.name, `Navnet er for langt (højst ${CENTRAL_LIMITS.name} tegn)`),
  );
const descriptionSchema = z
  .string()
  .max(CENTRAL_LIMITS.description, `Beskrivelsen er for lang (højst ${CENTRAL_LIMITS.description} tegn)`)
  .refine(noNul, NUL_MESSAGE)
  .refine(wellFormed, MALFORMED_MESSAGE)
  .transform(nfc)
  .pipe(
    z
      .string()
      .max(CENTRAL_LIMITS.description, `Beskrivelsen er for lang (højst ${CENTRAL_LIMITS.description} tegn)`),
  );
// The prompt is trimmed and made NFC; the limit applies to the stored (NFC) text.
const promptSchema = z
  .string()
  .max(CENTRAL_LIMITS.prompt * 4, `Prompten er for lang (højst ${CENTRAL_LIMITS.prompt} tegn)`)
  .refine(noNul, NUL_MESSAGE)
  .refine(wellFormed, MALFORMED_MESSAGE)
  .transform((v) => nfc(v).trim())
  .pipe(
    z
      .string()
      .min(1, 'Prompten er påkrævet')
      .max(CENTRAL_LIMITS.prompt, `Prompten er for lang (højst ${CENTRAL_LIMITS.prompt} tegn)`),
  );

const contentShape = {
  name: nameSchema,
  description: descriptionSchema,
  prompt: promptSchema,
  includeDeltagere: z.boolean(),
  includeBeslutningspunkter: z.boolean(),
  includeDagsorden: z.boolean(),
  includeDato: z.boolean(),
  allowUserInstruction: z.boolean(),
  allowToggleOverrides: z.boolean(),
};

export const createCentralTemplateSchema = z
  .object({
    // Omitted or null = an organisation-wide template (global managers only).
    ownerOrgUnitUuid: uuidSchema.nullish().transform((v) => v ?? null),
    name: contentShape.name,
    description: contentShape.description.default(''),
    prompt: contentShape.prompt,
    includeDeltagere: contentShape.includeDeltagere.default(false),
    includeBeslutningspunkter: contentShape.includeBeslutningspunkter.default(false),
    includeDagsorden: contentShape.includeDagsorden.default(false),
    includeDato: contentShape.includeDato.default(false),
    allowUserInstruction: contentShape.allowUserInstruction.default(false),
    allowToggleOverrides: contentShape.allowToggleOverrides.default(false),
    targets: centralTargetsSchema.default([]),
    principalTargets: centralPrincipalTargetsSchema.default([]),
    changeNote: changeNoteSchema,
  })
  .strict();

const baseVersionSchema = z.number().int().min(1).max(1_000_000);

export const updateCentralTemplateSchema = z
  .object({
    baseVersion: baseVersionSchema,
    changeNote: changeNoteSchema,
    name: contentShape.name.optional(),
    description: contentShape.description.optional(),
    prompt: contentShape.prompt.optional(),
    includeDeltagere: contentShape.includeDeltagere.optional(),
    includeBeslutningspunkter: contentShape.includeBeslutningspunkter.optional(),
    includeDagsorden: contentShape.includeDagsorden.optional(),
    includeDato: contentShape.includeDato.optional(),
    allowUserInstruction: contentShape.allowUserInstruction.optional(),
    allowToggleOverrides: contentShape.allowToggleOverrides.optional(),
    targets: centralTargetsSchema.optional(),
    principalTargets: centralPrincipalTargetsSchema.optional(),
  })
  .strict();

/** Body of archive and restore. */
export const centralStateChangeSchema = z
  .object({ baseVersion: baseVersionSchema, changeNote: changeNoteSchema })
  .strict();

export const centralStatusFilterSchema = z.enum(['active', 'archived', 'all']);
export type CentralStatusFilter = z.output<typeof centralStatusFilterSchema>;

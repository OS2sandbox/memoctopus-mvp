import { z } from 'zod';
import { CENTRAL_LIMITS } from './central-types';

// Request bodies for the manager-side central template routes. Every object is
// strict: unknown keys are rejected, never silently ignored. Messages are
// Danish; the routes only echo issue paths and codes (access-http.ts), the
// service layer raises the same messages as ValidationError.

export const CHANGE_NOTE_MESSAGE = 'Beskriv ændringen (mindst 10 tegn)';
export const NUL_MESSAGE = 'Teksten må ikke indeholde nul-tegn';
// Postgres text and jsonb cannot hold U+0000; left to the database it surfaces as a 500.
const noNul = (v: string) => !v.includes('\u0000');

export const CHANGE_NOTE_TOO_LONG_MESSAGE = `Ændringsbeskrivelsen er for lang (højst ${CENTRAL_LIMITS.changeNoteMax} tegn)`;

// Invisible characters would let a note of "nothing" satisfy the length rule: control
// and format characters (zero-width space/joiner, word joiner, BOM, soft hyphen, ...)
// plus the blank "letters" that render as empty (Hangul fillers, braille blank).
// Newlines, carriage returns and tabs are kept: the note is typed in a textarea.
const INVISIBLE = /(?![\n\r\t])[\p{Cc}\p{Cf}]|[\u115f\u1160\u2800\u3164\uffa0]/gu;
export const normalizeChangeNote = (v: string): string => v.replace(INVISIBLE, '').trim();

// NUL is checked on the raw value (stripping it silently would hide it). The raw cap
// bounds the work of the strip. After stripping and trimming, a note of only spaces or
// invisible characters does not count. The minimum counts code points, like Postgres
// char_length in the table CHECK: 5 emoji are 10 UTF-16 units but only 5 characters,
// and must not slip past this check just to fail the database constraint. The stored
// note is the normalised one.
export const changeNoteSchema = z
  .string({ required_error: CHANGE_NOTE_MESSAGE, invalid_type_error: CHANGE_NOTE_MESSAGE })
  .max(CENTRAL_LIMITS.changeNoteMax * 4, CHANGE_NOTE_TOO_LONG_MESSAGE)
  .refine(noNul, NUL_MESSAGE)
  .transform(normalizeChangeNote)
  .pipe(
    z
      .string()
      .max(CENTRAL_LIMITS.changeNoteMax, CHANGE_NOTE_TOO_LONG_MESSAGE)
      .refine((v) => [...v].length >= CENTRAL_LIMITS.changeNoteMin, CHANGE_NOTE_MESSAGE),
  );

const uuidSchema = z.string().uuid().transform((v) => v.toLowerCase());

export const centralTargetSchema = z
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
  .max(CENTRAL_LIMITS.targets, `Højst ${CENTRAL_LIMITS.targets} modtagere`)
  .transform((targets) => dedupeTargets(targets));

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Navn er påkrævet')
  .max(CENTRAL_LIMITS.name, `Navnet er for langt (højst ${CENTRAL_LIMITS.name} tegn)`)
  .refine(noNul, NUL_MESSAGE);
const descriptionSchema = z
  .string()
  .max(CENTRAL_LIMITS.description, `Beskrivelsen er for lang (højst ${CENTRAL_LIMITS.description} tegn)`)
  .refine(noNul, NUL_MESSAGE);
const promptSchema = z
  .string()
  .trim()
  .min(1, 'Prompten er påkrævet')
  .max(CENTRAL_LIMITS.prompt, `Prompten er for lang (højst ${CENTRAL_LIMITS.prompt} tegn)`)
  .refine(noNul, NUL_MESSAGE);

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
    ownerOrgUnitUuid: uuidSchema,
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
    changeNote: changeNoteSchema,
  })
  .strict();
export type CreateCentralTemplateInput = z.output<typeof createCentralTemplateSchema>;

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
  })
  .strict();
export type UpdateCentralTemplateInput = z.output<typeof updateCentralTemplateSchema>;

/** Body of archive and restore. */
export const centralStateChangeSchema = z
  .object({ baseVersion: baseVersionSchema, changeNote: changeNoteSchema })
  .strict();
export type CentralStateChangeInput = z.output<typeof centralStateChangeSchema>;

export const centralStatusFilterSchema = z.enum(['active', 'archived', 'all']);
export type CentralStatusFilter = z.output<typeof centralStatusFilterSchema>;

import { z } from 'zod';
import { ROLE_KEYS } from './types';

// Request-body building blocks shared by the local-provider routes. Every
// object schema using them is .strict(): unknown keys are rejected, not ignored.

export const uuidSchema = z.string().uuid();

export const roleKeySchema = z.enum(ROLE_KEYS);

export const orgUnitNameSchema = z.string().trim().min(1).max(200);

// App user ids are better-auth strings, not uuids.
export const appUserIdSchema = z.string().min(1).max(128);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** ISO date or date-time string, coerced to a Date; rejects numbers and free text. */
export const isoDateSchema = z
  .string()
  .max(40)
  .regex(ISO_DATE)
  .pipe(z.coerce.date());

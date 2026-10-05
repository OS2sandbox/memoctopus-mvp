// Shared building blocks for the closed event catalogue. A details schema may
// only use these primitives (enums, numbers, booleans, uuids, short codes), so
// free text cannot be expressed. record.ts enforces the same rules again on the
// parsed value as defence in depth.
import { z } from 'zod';

/** What every string in `details` must look like: no whitespace, so prose cannot pass. */
export const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export const EVENT_SOURCES = ['server', 'client', 'system'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_OUTCOMES = ['success', 'denied', 'error'] as const;
export type EventOutcome = (typeof EVENT_OUTCOMES)[number];

/** A short machine code such as `rate_limited`. Prefer z.enum when the vocabulary is closed. */
export const code = () => z.string().regex(CODE_RE);

export const uuid = () => z.string().uuid();

export const count = () => z.number().int().min(0).max(1_000_000_000);

/** Seconds or milliseconds as a plain non-negative number. */
export const amount = () => z.number().finite().min(0).max(1_000_000_000_000);

/** Field names (never values) as codes, at most 32. */
export const codeList = () => z.array(code()).max(32);

export interface EventDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Which sources may emit it. The first one is the default. */
  sources: readonly [EventSource, ...EventSource[]];
  /**
   * The only entity type this event may reference, or null when it references no
   * entity. With `anyEntityType` the caller picks a type code instead (authz.denied).
   */
  entityType: string | null;
  anyEntityType?: true;
  /** Whether `entityId` must be present (a UUID). */
  entityIdRequired: boolean;
  /** Allowed types for the secondary entity; omit when the event has none. */
  secondaryEntityTypes?: readonly string[];
  /** Used when the caller gives no outcome. Default 'success'. */
  defaultOutcome?: EventOutcome;
  /** STRICT: unknown keys are rejected. */
  details: S;
}

/** Identity function: exists so each catalogue entry is type-checked and its details type is inferred. */
export function defineEvent<S extends z.ZodTypeAny>(def: EventDef<S>): EventDef<S> {
  return def;
}

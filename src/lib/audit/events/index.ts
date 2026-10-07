// Closed event catalogue: the only event types record() accepts. One file per
// domain; this file only aggregates. Adding a NEW event type name is a change to
// this contract (ask the audit owner); refining the details of an existing one is
// the domain owner's call.
import type { z } from 'zod';
import { aiEvents } from './ai';
import { auditEvents } from './audit';
import { authEvents } from './auth';
import { botEvents } from './bot';
import { centralTemplateEvents } from './central-template';
import { meetingEvents } from './meeting';
import { systemEvents } from './system';
import { templateEvents } from './template';
import type { EventDef, EventOutcome, EventSource } from './types';

export const EVENT_CATALOGUE = {
  ...authEvents,
  ...templateEvents,
  ...centralTemplateEvents,
  ...aiEvents,
  ...botEvents,
  ...meetingEvents,
  ...systemEvents,
  ...auditEvents,
} as const;

export type EventType = keyof typeof EVENT_CATALOGUE;
export const EVENT_TYPES = Object.keys(EVENT_CATALOGUE) as EventType[];

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EVENT_CATALOGUE, value);
}

export function eventDef(type: EventType): EventDef {
  return EVENT_CATALOGUE[type] as EventDef;
}

/** What a caller passes as `details` for event type T (schema input, so optional keys stay optional). */
export type EventDetails<T extends EventType> = z.input<(typeof EVENT_CATALOGUE)[T]['details']>;

type DetailsField<T extends EventType> = Record<string, never> extends EventDetails<T>
  ? { details?: EventDetails<T> }
  : { details: EventDetails<T> };

interface EventCommon {
  outcome?: EventOutcome;
  /** Defaults to the first source the catalogue allows for the type. */
  source?: EventSource;
  /** The acting user. null/absent for unauthenticated events (e.g. a failed login). */
  actorUserId?: string | null;
  entityType?: string;
  /** Opaque id, validated as a UUID. */
  entityId?: string;
  secondaryEntityType?: string;
  secondaryEntityId?: string;
  /** Client delivery only: makes redelivery idempotent per actor. */
  clientEventId?: string;
  clientOccurredAt?: Date;
}

/** One event of type T; `details` is checked against that type's schema. */
export type AuditEventOf<T extends EventType> = EventCommon & { type: T } & DetailsField<T>;

/** Any catalogue event (a discriminated union on `type`). */
export type AuditEventInput = { [T in EventType]: AuditEventOf<T> }[EventType];

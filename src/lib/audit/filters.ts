// Query-string contract shared by the viewer route and the export route.
import { z } from 'zod';
import { isEventType } from './events';
import { EVENT_OUTCOMES, EVENT_SOURCES } from './events/types';
import type { AuditFilters } from './query';

const eventType = z.string().refine(isEventType, 'unknown event type');
const dateTime = z.string().datetime({ offset: true }).max(40);

export const filterShape = {
  eventType: z.array(eventType).min(1).max(50).optional(),
  actorUserId: z
    .string()
    .min(1)
    .max(128)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\s\u0000-\u001f]+$/)
    .optional(),
  entityId: z.string().uuid().optional(),
  outcome: z.enum(EVENT_OUTCOMES).optional(),
  source: z.enum(EVENT_SOURCES).optional(),
  from: dateTime.optional(),
  to: dateTime.optional(),
};

/**
 * URLSearchParams -> plain object. Only `eventType` may repeat; any other
 * repeated key stays an array so the strict schema rejects it (400).
 */
export function searchParamsToObject(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = key === 'eventType' || all.length > 1 ? all : all[0];
  }
  return out;
}

export function toFilters(q: {
  eventType?: string[];
  actorUserId?: string;
  entityId?: string;
  outcome?: AuditFilters['outcome'];
  source?: AuditFilters['source'];
  from?: string;
  to?: string;
}): AuditFilters {
  return {
    eventTypes: q.eventType,
    actorUserId: q.actorUserId,
    entityId: q.entityId,
    outcome: q.outcome,
    source: q.source,
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
  };
}

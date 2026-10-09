import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withHandler } from '@/lib/api-handler';
import { auditFeedDelaySeconds } from '@/lib/audit/config';
import { feedGuard } from '@/lib/audit/feed-auth';
import { getFeedPage, MAX_FEED_SIZE, type AuditEventRow } from '@/lib/audit/query';
import { parseWith } from '@/lib/authz/access-http';

const DEFAULT_FEED_SIZE = 100;

const querySchema = z
  .object({
    offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    size: z.coerce.number().int().min(1).max(MAX_FEED_SIZE).optional(),
  })
  .strict();

// The service key reads the whole log, so every stored field is included, but the
// IP and user agent keys only when something was stored.
function record(row: AuditEventRow) {
  return {
    id: Number(row.id),
    occurredAt: row.occurredAt.toISOString(),
    source: row.source,
    eventType: row.eventType,
    outcome: row.outcome,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    actorOrgUnitUuid: row.actorOrgUnitUuid,
    entityType: row.entityType,
    entityId: row.entityId,
    secondaryEntityType: row.secondaryEntityType,
    secondaryEntityId: row.secondaryEntityId,
    requestId: row.requestId,
    details: row.details,
    clientOccurredAt: row.clientOccurredAt ? row.clientOccurredAt.toISOString() : null,
    ...(row.ipAddress ? { ipAddress: row.ipAddress } : {}),
    ...(row.userAgent ? { userAgent: row.userAgent } : {}),
  };
}

// Machine endpoint: authenticated by the service key only, no session.
export const GET = withHandler('audit/feed GET', async (req: NextRequest) => {
  const denied = feedGuard(req);
  if (denied) return denied;
  const parsed = parseWith(querySchema, Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.ok) return parsed.response;

  const { rows, next } = await getFeedPage({
    offset: parsed.data.offset ?? 0,
    size: parsed.data.size ?? DEFAULT_FEED_SIZE,
    delaySeconds: auditFeedDelaySeconds(),
  });
  return NextResponse.json({ records: rows.map(record), next }, { headers: { 'Cache-Control': 'no-store' } });
});

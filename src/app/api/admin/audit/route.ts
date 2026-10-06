import { NextResponse } from 'next/server';
import { z } from 'zod';
import { changeNotesFor, type ChangeNote } from '@/lib/audit/change-notes';
import { filterShape, searchParamsToObject, toFilters } from '@/lib/audit/filters';
import { auditScopeFor, listAuditEvents, MAX_PAGE_SIZE, type AuditEventRow } from '@/lib/audit/query';
import { parseWith } from '@/lib/authz/access-http';
import { withAuthz } from '@/lib/authz/guard';
import { safeLogError } from '@/lib/audit/safe-log';

const querySchema = z
  .object({
    ...filterShape,
    cursor: z.string().regex(/^\d{1,18}$/).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  })
  .strict();

// Explicit whitelist (never a spread of the row): a column added later does not
// reach the browser by accident. Network data is for global readers only.
function view(row: AuditEventRow, includeNetwork: boolean, note?: ChangeNote) {
  return {
    id: row.id,
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
    // Looked up from the template changelog at read time; audit_events itself holds no note.
    ...(note ? { changeNote: note.changeNote, templateName: note.templateName } : {}),
    ...(includeNetwork ? { ipAddress: row.ipAddress, userAgent: row.userAgent } : {}),
  };
}

export const GET = withAuthz('admin/audit GET', 'audit.read', async (req, { principal }) => {
  const parsed = parseWith(querySchema, searchParamsToObject(req.nextUrl.searchParams));
  if (!parsed.ok) return parsed.response;
  const { cursor, limit, ...filters } = parsed.data;

  const scope = await auditScopeFor(principal);
  const page = await listAuditEvents({ filters: toFilters(filters), cursor, limit, scope });
  const notes = await changeNotesFor(page.rows).catch((err) => {
    // The log must stay readable if the changelog lookup fails; the note is then simply absent.
    safeLogError('admin/audit change notes', err);
    return new Map<string, ChangeNote>();
  });
  return NextResponse.json(
    { events: page.rows.map((r) => view(r, scope.all, notes.get(r.id))), nextCursor: page.nextCursor },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});

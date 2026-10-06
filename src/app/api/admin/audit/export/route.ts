import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auditRowsToCsv } from '@/lib/audit/csv';
import { filterShape, searchParamsToObject, toFilters } from '@/lib/audit/filters';
import { auditScopeFor, collectAuditEvents } from '@/lib/audit/query';
import { recordServerEvent } from '@/lib/audit/record';
import { parseWith } from '@/lib/authz/access-http';
import { withAuthz } from '@/lib/authz/guard';

/** Hard cap on one export; a larger result is cut off and flagged (X-Audit-Truncated). */
const EXPORT_MAX_ROWS = 50_000;

const querySchema = z.object(filterShape).strict();

export const GET = withAuthz('admin/audit/export GET', 'audit.export', async (req, { principal, session }) => {
  const parsed = parseWith(querySchema, searchParamsToObject(req.nextUrl.searchParams));
  if (!parsed.ok) return parsed.response;

  // audit.export is global-only, but the rows are still limited by the caller's
  // audit.read scope: an export can never show more than the viewer does.
  const scope = await auditScopeFor(principal);
  const { rows, truncated } = await collectAuditEvents({
    filters: toFilters(parsed.data),
    scope,
    maxRows: EXPORT_MAX_ROWS,
  });

  // The export is recorded BEFORE the file leaves. If that record cannot be
  // written the export is refused: handing out the log without a trace of it
  // would defeat the point of the log.
  const recorded = await recordServerEvent(req, {
    type: 'audit.export',
    actorUserId: session.user.id,
    details: { rowCount: rows.length, format: 'csv', ...(truncated ? { truncated: true } : {}) },
  });
  if (recorded.status === 'dropped') {
    return NextResponse.json({ error: 'Eksporten kunne ikke logges og er derfor afvist' }, { status: 500 });
  }

  const day = new Date().toISOString().slice(0, 10);
  return new Response(auditRowsToCsv(rows), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="log-${day}.csv"`,
      'Cache-Control': 'no-store',
      'X-Audit-Truncated': truncated ? 'true' : 'false',
    },
  });
});

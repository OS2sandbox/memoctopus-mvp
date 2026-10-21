import { NextResponse } from 'next/server';
import { z } from 'zod';
import { changeNotesFor } from '@/lib/audit/change-notes';
import { AUDIT_EXPORT_MAX_ROWS, AUDIT_TRUNCATED_HEADER, auditExportFilename, auditRowsToCsv } from '@/lib/audit/csv';
import { filterShape, searchParamsToObject, toFilters } from '@/lib/audit/filters';
import { auditScopeFor, collectAuditEvents } from '@/lib/audit/query';
import { recordServerEvent } from '@/lib/audit/record';
import { safeLogError } from '@/lib/audit/safe-log';
import { parseWith } from '@/lib/authz/access-http';
import { withAuthz } from '@/lib/authz/guard';

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
    maxRows: AUDIT_EXPORT_MAX_ROWS,
  });

  // The change notes (the reason for a template change) are looked up at read time and belong in the
  // file. An export that cannot get them is refused rather than handed out with silent gaps.
  let notes;
  try {
    notes = await changeNotesFor(rows);
  } catch (err) {
    safeLogError('admin/audit/export change notes', err);
    return NextResponse.json({ error: 'Eksporten kunne ikke hente ændringsbeskrivelserne og er derfor afvist' }, { status: 500 });
  }

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
  return new Response(auditRowsToCsv(rows, notes), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${auditExportFilename(day, truncated)}"`,
      'Cache-Control': 'no-store',
      [AUDIT_TRUNCATED_HEADER]: truncated ? 'true' : 'false',
    },
  });
});

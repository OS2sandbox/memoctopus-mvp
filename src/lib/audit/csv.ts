// CSV for the audit export. RFC 4180 quoting, CRLF line ends, comma separated
// (what log tooling expects), a UTF-8 BOM so Excel reads æøå correctly.
//
// Cells are also made safe against spreadsheet formula injection: a cell that
// starts with = + - @ tab or CR/LF would be evaluated by Excel or Sheets, and
// some of these fields (an actor's display name) are not under our control.
import type { AuditEventRow } from './query';
import { eventTypeLabel, outcomeLabels, sourceLabels } from './labels.da';

const BOM = '\uFEFF';
const FORMULA_START = /^[=+\-@\t\r\n]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One safe, correctly quoted CSV cell. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  // The apostrophe makes spreadsheets treat the cell as text; it is the standard mitigation.
  if (FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const CSV_HEADER = [
  'Tidspunkt (UTC)',
  'Hændelse',
  'Hændelseskode',
  'Resultat',
  'Kilde',
  'Bruger-id',
  'Brugernavn',
  'Enhed (bruger)',
  'Objekttype',
  'Objekt-id',
  'Sekundær objekttype',
  'Sekundær objekt-id',
  'IP-adresse',
  'Browser',
  'Anmodnings-id',
  'Detaljer',
] as const;

export function auditRowToCsvFields(row: AuditEventRow): unknown[] {
  return [
    row.occurredAt,
    eventTypeLabel(row.eventType),
    row.eventType,
    outcomeLabels[row.outcome] ?? row.outcome,
    sourceLabels[row.source] ?? row.source,
    row.actorUserId,
    row.actorName,
    row.actorOrgUnitUuid,
    row.entityType,
    row.entityId,
    row.secondaryEntityType,
    row.secondaryEntityId,
    row.ipAddress,
    row.userAgent,
    row.requestId,
    JSON.stringify(row.details),
  ];
}

/** The whole file: BOM, header, one line per row. */
export function auditRowsToCsv(rows: readonly AuditEventRow[]): string {
  const lines = [CSV_HEADER.map(csvCell).join(','), ...rows.map((r) => auditRowToCsvFields(r).map(csvCell).join(','))];
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

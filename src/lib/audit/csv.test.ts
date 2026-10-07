import { describe, expect, it } from 'vitest';
import { AUDIT_EXPORT_MAX_ROWS, CSV_HEADER, auditExportFilename, auditRowToCsvFields, auditRowsToCsv, csvCell } from './csv';
import type { AuditEventRow } from './query';

const row = (over: Partial<AuditEventRow> = {}): AuditEventRow => ({
  id: '7',
  occurredAt: new Date('2026-10-05T09:30:00.000Z'),
  source: 'server',
  eventType: 'export.download',
  outcome: 'success',
  actorUserId: 'u1',
  actorName: 'Anne Admin',
  actorOrgUnitUuid: null,
  entityType: 'meeting',
  entityId: '11111111-1111-4111-8111-111111111111',
  secondaryEntityType: null,
  secondaryEntityId: null,
  ipAddress: '10.0.0.1',
  userAgent: 'Mozilla/5.0',
  requestId: 'req-1',
  details: { format: 'pdf' },
  clientOccurredAt: null,
  ...over,
});

describe('csvCell', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd', '\ncmd'])(
    'prefixes a single quote when a cell starts with %j',
    (input) => {
      const out = csvCell(input);
      expect(out.replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );

  it('does not touch a cell where the dangerous character is not first', () => {
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('x-y')).toBe('x-y');
  });

  it('quotes cells with comma, quote or line break, doubling inner quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('quotes AND neutralises a formula that also contains a comma', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  });

  it('writes null and undefined as empty, numbers and dates as text', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(new Date('2026-10-05T09:30:00.000Z'))).toBe('2026-10-05T09:30:00.000Z');
  });
});

describe('auditRowsToCsv', () => {
  it('starts with a BOM and the Danish header, one CRLF line per row', () => {
    const csv = auditRowsToCsv([row(), row({ id: '8' })]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(CSV_HEADER.map(csvCell).join(','));
    expect(lines).toHaveLength(4); // header + 2 rows + trailing empty
    expect(lines[3]).toBe('');
  });

  it('has as many fields per row as the header, and labels the event in Danish', () => {
    const fields = auditRowToCsvFields(row());
    expect(fields).toHaveLength(CSV_HEADER.length);
    expect(fields[2]).toBe('Eksport hentet');
    expect(fields[3]).toBe('export.download');
    expect(fields[4]).toBe('Gennemført');
  });

  it('labels a client event as reported by the client', () => {
    expect(auditRowToCsvFields(row({ source: 'client' }))[5]).toBe('Selvrapporteret af klienten');
  });

  it('has a self-reported client time column, empty unless the event carries one', () => {
    const at = CSV_HEADER.indexOf('Tidspunkt (klient, selvrapporteret)');
    expect(at).toBe(1);
    expect(auditRowToCsvFields(row())[at]).toBeNull();
    const t = new Date('2026-10-05T07:00:00.000Z');
    expect(auditRowToCsvFields(row({ source: 'client', clientOccurredAt: t }))[at]).toBe(t);
    expect(auditRowsToCsv([row({ source: 'client', clientOccurredAt: t })])).toContain('2026-10-05T07:00:00.000Z');
  });

  it('shows a type this build does not know instead of hiding the row', () => {
    const fields = auditRowToCsvFields(row({ eventType: 'future.thing' }));
    expect(fields[2]).toBe('Ukendt hændelsestype (future.thing)');
    expect(fields[3]).toBe('future.thing');
  });

  it('neutralises a hostile actor name', () => {
    const csv = auditRowsToCsv([row({ actorName: '=cmd|\' /C calc\'!A0' })]);
    expect(csv).toContain(`,'=cmd|`);
    expect(csv).not.toMatch(/,=cmd/);
  });

  it('serialises details as JSON in one cell', () => {
    const csv = auditRowsToCsv([row({ details: { format: 'pdf', n: 2 } })]);
    expect(csv).toContain('"{""format"":""pdf"",""n"":2}"');
  });

  it('survives an empty result: header only', () => {
    expect(auditRowsToCsv([])).toBe(`\uFEFF${CSV_HEADER.map(csvCell).join(',')}\r\n`);
  });

  it('names a truncated export -afkortet and keeps the cap shared', () => {
    expect(auditExportFilename('2026-10-06', false)).toBe('log-2026-10-06.csv');
    expect(auditExportFilename('2026-10-06', true)).toBe('log-2026-10-06-afkortet.csv');
    expect(AUDIT_EXPORT_MAX_ROWS).toBe(50_000);
  });
});

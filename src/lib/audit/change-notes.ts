// Read-time join between the audit log and the central template changelog.
//
// audit_events never stores a change note (free text; see events/central-template.ts).
// The viewer still has to show it, because it is the documented reason for a change. So
// the note is looked up here, at read time, from central_template_versions by the
// (template id, version) the event already carries. Nothing is copied into audit_events.
//
// Who sees it: whoever may read the audit event (audit.read, already scoped by the
// event's actor unit). A change note describes a change, it is not the prompt; the prompt
// itself is never part of this lookup.
import { pool } from '@/lib/db';
import { UUID_RE } from './record';
import type { AuditEventRow } from './query';

/** The five write events; `central_template.read` has no change of its own. */
const CHANGE_EVENTS = new Set([
  'central_template.create',
  'central_template.update',
  'central_template.retarget',
  'central_template.archive',
  'central_template.restore',
]);

export interface ChangeNote {
  changeNote: string;
  /** The template's name as written in the changelog snapshot of that version. */
  templateName: string | null;
}

interface Env {
  query: (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

const key = (templateId: string, version: number) => `${templateId.toLowerCase()}:${version}`;

/** Change notes for the central template events among `rows`, keyed by row id. One query. */
export async function changeNotesFor(
  rows: AuditEventRow[],
  env: Env = { query: (t, p) => pool.query(t, p) },
): Promise<Map<string, ChangeNote>> {
  const wanted: Array<{ rowId: string; templateId: string; version: number }> = [];
  for (const r of rows) {
    if (!CHANGE_EVENTS.has(r.eventType) || !r.entityId || !UUID_RE.test(r.entityId)) continue;
    const version = r.details.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) continue;
    wanted.push({ rowId: r.id, templateId: r.entityId, version });
  }
  const out = new Map<string, ChangeNote>();
  if (wanted.length === 0) return out;

  const res = await env.query(
    `SELECT template_id, version, change_note, content->>'name' AS template_name
       FROM public.central_template_versions
      WHERE (template_id, version) IN (SELECT * FROM unnest($1::uuid[], $2::int[]))`,
    [wanted.map((w) => w.templateId), wanted.map((w) => w.version)],
  );
  const found = new Map<string, ChangeNote>();
  for (const r of res.rows) {
    found.set(key(String(r.template_id), Number(r.version)), {
      changeNote: String(r.change_note),
      templateName: r.template_name === null || r.template_name === undefined ? null : String(r.template_name),
    });
  }
  for (const w of wanted) {
    const hit = found.get(key(w.templateId, w.version));
    if (hit) out.set(w.rowId, hit);
  }
  return out;
}

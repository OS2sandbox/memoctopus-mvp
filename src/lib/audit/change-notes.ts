// Read-time join between the audit log and the template changelogs.
//
// audit_events never stores a change note (free text; see events/central-template.ts and
// events/template.ts). The viewer and the CSV export still show it, because it is the documented
// reason for a change. So the note is looked up here, at read time, by the (template id, version)
// the event already carries: from central_template_versions for the central templates, and from the
// acting person's own skabelon_versions for a personal template edit. Nothing is copied into audit_events.
//
// Who sees it: whoever may read the audit event (audit.read, already scoped by the event's actor
// unit; the CSV additionally needs audit.export). A change note describes a change, it is not the
// prompt; the prompt itself is never part of this lookup. A personal note is text the person wrote
// in their own template history: it reaches log readers only through this lookup.
import { pool } from '@/lib/db';
import { getUserSchemaName } from '@/lib/db/user-schema';
import { safeLogError } from './safe-log';
import { UUID_RE } from './record';
import type { AuditEventRow } from './query';

/** The five write events of a central template; each carries the version whose note is shown. */
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
  /** Personal notes of ONE person, by (template id, version), from that person's own schema. */
  personal?: (userId: string, templateIds: string[], versions: number[]) => Promise<Array<Record<string, unknown>>>;
}

/** Schema names are built from the actor id: only ids that are plain identifiers are ever interpolated. */
const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

async function personalNotes(userId: string, templateIds: string[], versions: number[]): Promise<Array<Record<string, unknown>>> {
  if (!SAFE_USER_ID.test(userId)) return [];
  const schema = getUserSchemaName(userId);
  try {
    const res = await pool.query(
      `SELECT skabelon_id, version, change_note
         FROM "${schema}".skabelon_versions
        WHERE change_note IS NOT NULL
          AND (skabelon_id, version) IN (SELECT * FROM unnest($1::text[], $2::int[]))`,
      [templateIds, versions],
    );
    return res.rows as Array<Record<string, unknown>>;
  } catch (err) {
    // A person without a schema or history table simply has no notes to show (3F000, 42P01); anything
    // else is logged without content and only costs that person's notes.
    const code = (err as { code?: string } | null)?.code;
    if (code !== '3F000' && code !== '42P01') safeLogError('audit personal change notes', err);
    return [];
  }
}

const key = (templateId: string, version: number) => `${templateId.toLowerCase()}:${version}`;

/** Change notes for the central template events among `rows`, keyed by row id. One query. */
export async function changeNotesFor(
  rows: AuditEventRow[],
  env: Env = { query: (t, p) => pool.query(t, p), personal: personalNotes },
): Promise<Map<string, ChangeNote>> {
  const wanted: Array<{ rowId: string; templateId: string; version: number }> = [];
  for (const r of rows) {
    if (!CHANGE_EVENTS.has(r.eventType) || !r.entityId || !UUID_RE.test(r.entityId)) continue;
    const version = r.details.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) continue;
    wanted.push({ rowId: r.id, templateId: r.entityId, version });
  }
  const out = new Map<string, ChangeNote>();
  await addPersonalNotes(out, rows, env);
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

/** Personal template edits that wrote a note: one lookup per person, in that person's own schema. */
async function addPersonalNotes(out: Map<string, ChangeNote>, rows: AuditEventRow[], env: Env): Promise<void> {
  if (!env.personal) return;
  const byActor = new Map<string, Array<{ rowId: string; templateId: string; version: number }>>();
  for (const r of rows) {
    if (r.eventType !== 'template.update' || r.details.hasChangeNote !== true) continue;
    if (!r.actorUserId || !r.entityId || !UUID_RE.test(r.entityId)) continue;
    const version = r.details.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) continue;
    const list = byActor.get(r.actorUserId) ?? [];
    list.push({ rowId: r.id, templateId: r.entityId, version });
    byActor.set(r.actorUserId, list);
  }
  for (const [userId, wanted] of byActor) {
    const found = new Map<string, string>();
    for (const r of await env.personal(userId, wanted.map((w) => w.templateId), wanted.map((w) => w.version))) {
      if (typeof r.change_note === 'string') found.set(key(String(r.skabelon_id), Number(r.version)), r.change_note);
    }
    for (const w of wanted) {
      const note = found.get(key(w.templateId, w.version));
      if (note) out.set(w.rowId, { changeNote: note, templateName: null });
    }
  }
}

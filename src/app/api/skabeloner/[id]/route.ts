import { NextRequest, NextResponse } from 'next/server';
import { getSkabelon, updateSkabelon, deleteSkabelon, recordSkabelonVersion } from '@/lib/skabeloner/server';
import { parseLocalChangeNote } from '@/lib/skabeloner/change-note';
import { withHandler } from '@/lib/api-handler';
import { recordServerEvent } from '@/lib/audit/record';
import type { Skabelon } from '@/types';
import { requireAppAccess } from '@/lib/authz/app-access';
import { UUID_RE } from '@/lib/audit/record';

type Ctx = { params: Promise<{ id: string }> };

// The id in the URL is not verified until the template is found: only a well-formed UUID becomes an entity.
const entityOf = (id: string) => (UUID_RE.test(id) ? { entityId: id } : {});

const TRACKED_FIELDS = [
  'name',
  'description',
  'prompt',
  'includeDeltagere',
  'includeBeslutningspunkter',
  'includeDagsorden',
  'includeDato',
] as const;

// Field NAMES only: the audit log must never carry the values (names, prompt text).
function changedFields(prev: Skabelon, next: Skabelon) {
  return TRACKED_FIELDS.filter((f) => prev[f] !== next[f]);
}

export const GET = withHandler('skabeloner/[id] GET', async (_req: NextRequest, { params }: Ctx) => {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const { id } = await params;
  const skabelon = await getSkabelon(session.user.id, id);
  if (!skabelon) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });
  return NextResponse.json({ skabelon });
});

export const PUT = withHandler('skabeloner/[id] PUT', async (req: NextRequest, { params }: Ctx) => {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'Navn er påkrævet' }, { status: 400 });
  // Optional note about this edit: kept in the person's own changelog, never audited or logged.
  const parsedNote = parseLocalChangeNote(body.changeNote);
  if (!parsedNote.ok) return NextResponse.json({ error: parsedNote.error, code: 'change_note_invalid' }, { status: 400 });
  const changeNote = parsedNote.note;

  const prev = await getSkabelon(session.user.id, id);
  if (!prev) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });

  let skabelon;
  try {
    skabelon = await updateSkabelon(session.user.id, id, {
      name,
      description: body.description,
      prompt: body.prompt,
      includeDeltagere: body.includeDeltagere,
      includeBeslutningspunkter: body.includeBeslutningspunkter,
      includeDagsorden: body.includeDagsorden,
      includeDato: body.includeDato,
    });
  } catch (err) {
    await recordServerEvent(req, {
      type: 'template.update',
      outcome: 'error',
      actorUserId: session.user.id,
      ...entityOf(id),
      details: { changedFields: [], hasChangeNote: changeNote !== null },
    });
    throw err;
  }
  if (!skabelon) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });
  const changed = changedFields(prev, skabelon);
  if (changed.length > 0) {
    await recordSkabelonVersion(session.user.id, skabelon, changed, changeNote);
    await recordServerEvent(req, {
      type: 'template.update',
      actorUserId: session.user.id,
      entityId: skabelon.id,
      // Whether a note was written, never the note.
      details: { changedFields: changed, hasChangeNote: changeNote !== null },
    });
  }
  return NextResponse.json({ skabelon });
});

export const DELETE = withHandler('skabeloner/[id] DELETE', async (req: NextRequest, { params }: Ctx) => {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const { id } = await params;
  let ok;
  try {
    ok = await deleteSkabelon(session.user.id, id);
  } catch (err) {
    await recordServerEvent(req, { type: 'template.delete', outcome: 'error', actorUserId: session.user.id, ...entityOf(id) });
    throw err;
  }
  if (!ok) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });
  await recordServerEvent(req, { type: 'template.delete', actorUserId: session.user.id, entityId: id });
  return NextResponse.json({ ok: true });
});

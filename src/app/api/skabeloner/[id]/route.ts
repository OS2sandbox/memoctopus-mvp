import { NextRequest, NextResponse } from 'next/server';
import { getSkabelon, updateSkabelon, deleteSkabelon } from '@/lib/skabeloner/server';
import { withHandler } from '@/lib/api-handler';
import { recordServerEvent } from '@/lib/audit/record';
import type { Skabelon } from '@/types';
import { requireAppAccess } from '@/lib/authz/app-access';

type Ctx = { params: Promise<{ id: string }> };

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

  const prev = await getSkabelon(session.user.id, id);
  if (!prev) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });

  const skabelon = await updateSkabelon(session.user.id, id, {
    name,
    description: body.description,
    prompt: body.prompt,
    includeDeltagere: body.includeDeltagere,
    includeBeslutningspunkter: body.includeBeslutningspunkter,
    includeDagsorden: body.includeDagsorden,
    includeDato: body.includeDato,
  });
  if (!skabelon) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });
  const changed = changedFields(prev, skabelon);
  if (changed.length > 0) {
    await recordServerEvent(req, {
      type: 'template.update',
      actorUserId: session.user.id,
      entityId: skabelon.id,
      details: { changedFields: changed },
    });
  }
  return NextResponse.json({ skabelon });
});

export const DELETE = withHandler('skabeloner/[id] DELETE', async (req: NextRequest, { params }: Ctx) => {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const { id } = await params;
  const ok = await deleteSkabelon(session.user.id, id);
  if (!ok) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });
  await recordServerEvent(req, { type: 'template.delete', actorUserId: session.user.id, entityId: id });
  return NextResponse.json({ ok: true });
});

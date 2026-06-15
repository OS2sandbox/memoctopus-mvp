import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getSkabelon, updateSkabelon, deleteSkabelon } from '@/lib/skabeloner/server';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const skabelon = await getSkabelon(session.user.id, id);
  if (!skabelon) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });
  return NextResponse.json({ skabelon });
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'Navn er påkrævet' }, { status: 400 });

  const skabelon = await updateSkabelon(session.user.id, id, {
    name,
    description: body.description,
    prompt: body.prompt,
    includeDeltagere: body.includeDeltagere,
    includeBeslutningspunkter: body.includeBeslutningspunkter,
    includeDagsorden: body.includeDagsorden,
  });
  if (!skabelon) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });
  return NextResponse.json({ skabelon });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const ok = await deleteSkabelon(session.user.id, id);
  if (!ok) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

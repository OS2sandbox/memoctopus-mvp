import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { listSkabeloner, createSkabelon } from '@/lib/skabeloner/server';

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const skabeloner = await listSkabeloner(session.user.id);
  return NextResponse.json({ skabeloner });
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'Navn er påkrævet' }, { status: 400 });

  const skabelon = await createSkabelon(session.user.id, {
    name,
    description: body.description,
    prompt: body.prompt,
    includeDeltagere: body.includeDeltagere,
    includeBeslutningspunkter: body.includeBeslutningspunkter,
    includeDagsorden: body.includeDagsorden,
    includeDato: body.includeDato,
  });
  return NextResponse.json({ skabelon }, { status: 201 });
}

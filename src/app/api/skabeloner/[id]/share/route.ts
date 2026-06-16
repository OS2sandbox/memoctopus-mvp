import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { sharedSkabeloner } from '@/lib/db/schema';
import { getSkabelon } from '@/lib/skabeloner/server';

type Ctx = { params: Promise<{ id: string }> };

// Publish a Skabelon to the shared (public) table and return an import token.
export async function POST(_req: NextRequest, { params }: Ctx) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const skabelon = await getSkabelon(session.user.id, id);
  if (!skabelon) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });

  const token = crypto.randomUUID();
  await db.insert(sharedSkabeloner).values({
    token,
    ownerUserId: session.user.id,
    name: skabelon.name,
    description: skabelon.description,
    prompt: skabelon.prompt,
    includeDeltagere: skabelon.includeDeltagere,
    includeBeslutningspunkter: skabelon.includeBeslutningspunkter,
    includeDagsorden: skabelon.includeDagsorden,
    includeDato: skabelon.includeDato,
  });

  return NextResponse.json({ token }, { status: 201 });
}

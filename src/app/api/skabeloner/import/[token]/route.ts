import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { sharedSkabeloner } from '@/lib/db/schema';
import { createSkabelon } from '@/lib/skabeloner/server';

type Ctx = { params: Promise<{ token: string }> };

async function loadShared(token: string) {
  const rows = await db
    .select()
    .from(sharedSkabeloner)
    .where(eq(sharedSkabeloner.token, token))
    .limit(1);
  return rows[0] ?? null;
}

// Preview a shared Skabelon.
export async function GET(_req: NextRequest, { params }: Ctx) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { token } = await params;
  const shared = await loadShared(token);
  if (!shared) return NextResponse.json({ error: 'Delingslink er ugyldigt' }, { status: 404 });

  return NextResponse.json({
    skabelon: {
      name: shared.name,
      description: shared.description,
      prompt: shared.prompt,
      includeDeltagere: shared.includeDeltagere,
      includeBeslutningspunkter: shared.includeBeslutningspunkter,
      includeDagsorden: shared.includeDagsorden,
    },
  });
}

// Import a shared Skabelon as a copy into the caller's own list.
export async function POST(_req: NextRequest, { params }: Ctx) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { token } = await params;
  const shared = await loadShared(token);
  if (!shared) return NextResponse.json({ error: 'Delingslink er ugyldigt' }, { status: 404 });

  const skabelon = await createSkabelon(session.user.id, {
    name: shared.name,
    description: shared.description,
    prompt: shared.prompt,
    includeDeltagere: shared.includeDeltagere,
    includeBeslutningspunkter: shared.includeBeslutningspunkter,
    includeDagsorden: shared.includeDagsorden,
  });

  return NextResponse.json({ skabelon }, { status: 201 });
}

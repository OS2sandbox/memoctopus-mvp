import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { sharedSkabeloner } from '@/lib/db/schema';
import { createSkabelon } from '@/lib/skabeloner/server';
import { getShareConfig } from '@/lib/skabeloner/share-config';
import { ensureSharedSkabelonerTable } from '@/lib/skabeloner/shared-table';
import { withHandler } from '@/lib/api-handler';

type Ctx = { params: Promise<{ token: string }> };

async function loadShared(token: string) {
  await ensureSharedSkabelonerTable();
  const rows = await db
    .select()
    .from(sharedSkabeloner)
    .where(eq(sharedSkabeloner.token, token))
    .limit(1);
  return rows[0] ?? null;
}

// Preview a shared Skabelon.
async function getHandler(_req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!getShareConfig().link) {
    return NextResponse.json({ error: 'Linkdeling er deaktiveret' }, { status: 403 });
  }

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
      includeDato: shared.includeDato,
    },
  });
}

// Import a shared Skabelon as a copy into the caller's own list.
async function postHandler(_req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!getShareConfig().link) {
    return NextResponse.json({ error: 'Linkdeling er deaktiveret' }, { status: 403 });
  }

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
    includeDato: shared.includeDato,
  });

  return NextResponse.json({ skabelon }, { status: 201 });
}

export const GET = withHandler('skabeloner/import/GET', getHandler);
export const POST = withHandler('skabeloner/import/POST', postHandler);

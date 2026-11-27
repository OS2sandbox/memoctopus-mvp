import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAppAccess } from '@/lib/authz/app-access';
import { db } from '@/lib/db';
import { sharedSkabeloner } from '@/lib/db/schema';
import { createSkabelon } from '@/lib/skabeloner/server';
import { getShareConfig } from '@/lib/skabeloner/share-config';
import { ensureSharedSkabelonerTable } from '@/lib/skabeloner/shared-table';
import { withHandler } from '@/lib/api-handler';
import { recordServerEvent } from '@/lib/audit/record';

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
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
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
async function postHandler(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;
  if (!getShareConfig().link) {
    return NextResponse.json({ error: 'Linkdeling er deaktiveret' }, { status: 403 });
  }

  const { token } = await params;
  const shared = await loadShared(token);
  if (!shared) return NextResponse.json({ error: 'Delingslink er ugyldigt' }, { status: 404 });

  let skabelon;
  try {
    skabelon = await createSkabelon(session.user.id, {
      name: shared.name,
      description: shared.description,
      prompt: shared.prompt,
      includeDeltagere: shared.includeDeltagere,
      includeBeslutningspunkter: shared.includeBeslutningspunkter,
      includeDagsorden: shared.includeDagsorden,
      includeDato: shared.includeDato,
    });
  } catch (err) {
    // Same trail as POST /api/skabeloner: the failed attempt is logged, the error still reaches withHandler (500).
    await recordServerEvent(req, { type: 'template.create', outcome: 'error', actorUserId: session.user.id, details: {} });
    throw err;
  }
  // An import is an ordinary template.create; never the token, name or prompt.
  await recordServerEvent(req, {
    type: 'template.create',
    actorUserId: session.user.id,
    entityId: skabelon.id,
    details: { hasPrompt: skabelon.prompt.trim().length > 0 },
  });

  return NextResponse.json({ skabelon }, { status: 201 });
}

export const GET = withHandler('skabeloner/import/GET', getHandler);
export const POST = withHandler('skabeloner/import/POST', postHandler);

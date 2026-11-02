import { NextRequest, NextResponse } from 'next/server';
import { listSkabeloner, createSkabelon, getCentralDefaultId } from '@/lib/skabeloner/server';
import { withHandler } from '@/lib/api-handler';
import { recordServerEvent } from '@/lib/audit/record';
import { safeLogError } from '@/lib/audit/safe-log';
import { listCentralForUser } from '@/lib/skabeloner/resolve';
import type { CentralSkabelonSummary } from '@/lib/skabeloner/central-types';
import { requireAppAccess } from '@/lib/authz/app-access';

async function getHandler(): Promise<NextResponse> {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const skabeloner = await listSkabeloner(session.user.id);
  // The central list is an addition: if it cannot be resolved the user keeps their personal templates,
  // and `centralError` tells the UI the shared list is missing (not "empty"), so it can say so.
  let centralSkabeloner: CentralSkabelonSummary[] = [];
  let centralError = false;
  try {
    centralSkabeloner = await listCentralForUser(session.user.id);
  } catch (err) {
    safeLogError('skabeloner/GET central', err);
    centralError = true;
  }
  // The default is ONE template: the person's central choice while it is still available to them, otherwise
  // the personal flag. An unavailable central default is simply ignored (the personal one applies again).
  let centralDefaultId: string | null = null;
  try {
    centralDefaultId = await getCentralDefaultId(session.user.id);
  } catch (err) {
    safeLogError('skabeloner/GET central default', err);
  }
  const centralDefault = centralDefaultId ? centralSkabeloner.find((c) => c.id === centralDefaultId) : undefined;
  return NextResponse.json({
    skabeloner: centralDefault ? skabeloner.map((s) => ({ ...s, isDefault: false })) : skabeloner,
    centralSkabeloner: centralSkabeloner.map((c) => ({ ...c, isDefault: c.id === centralDefault?.id })),
    ...(centralError ? { centralError: true } : {}),
  });
}

async function postHandler(req: NextRequest): Promise<NextResponse> {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'Navn er påkrævet' }, { status: 400 });

  let skabelon;
  try {
    skabelon = await createSkabelon(session.user.id, {
      name,
      description: body.description,
      prompt: body.prompt,
      includeDeltagere: body.includeDeltagere,
      includeBeslutningspunkter: body.includeBeslutningspunkter,
      includeDagsorden: body.includeDagsorden,
      includeDato: body.includeDato,
    });
  } catch (err) {
    // The failed attempt is part of the trail too; the error itself still reaches withHandler (500).
    await recordServerEvent(req, { type: 'template.create', outcome: 'error', actorUserId: session.user.id, details: {} });
    throw err;
  }
  await recordServerEvent(req, {
    type: 'template.create',
    actorUserId: session.user.id,
    entityId: skabelon.id,
    details: { hasPrompt: skabelon.prompt.trim().length > 0 },
  });
  return NextResponse.json({ skabelon }, { status: 201 });
}

export const GET = withHandler('skabeloner/GET', getHandler);
export const POST = withHandler('skabeloner/POST', postHandler);

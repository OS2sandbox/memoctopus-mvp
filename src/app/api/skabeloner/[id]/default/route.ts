import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { setDefaultSkabelon } from '@/lib/skabeloner/server';
import { withHandler } from '@/lib/api-handler';
import { recordServerEvent } from '@/lib/audit/record';

type Ctx = { params: Promise<{ id: string }> };

// Mark a Skabelon as the user's default (the one preselected in gennemgang).
export const POST = withHandler('skabeloner/default', async (req: NextRequest, { params }: Ctx) => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const skabelon = await setDefaultSkabelon(session.user.id, id);
  if (!skabelon) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });
  await recordServerEvent(req, { type: 'template.set_default', actorUserId: session.user.id, entityId: skabelon.id });
  return NextResponse.json({ skabelon });
});

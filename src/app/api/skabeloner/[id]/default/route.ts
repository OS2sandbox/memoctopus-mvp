import { NextRequest, NextResponse } from 'next/server';
import { setCentralDefault, setDefaultSkabelon } from '@/lib/skabeloner/server';
import { listCentralForUser } from '@/lib/skabeloner/resolve';
import { withHandler } from '@/lib/api-handler';
import { requireAppAccess } from '@/lib/authz/app-access';

type Ctx = { params: Promise<{ id: string }> };

// Mark a Skabelon as the user's default (the one preselected in gennemgang): one of their own, or a central
// one that is available to them. Ids are uuids, so the two kinds cannot collide. A personal preference, not an
// audited action. A central id that is unknown, archived or not for this person answers the same 404.
export const POST = withHandler('skabeloner/default', async (_req: NextRequest, { params }: Ctx) => {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;
  const userId = session.user.id;

  const { id } = await params;
  const skabelon = await setDefaultSkabelon(userId, id);
  if (skabelon) return NextResponse.json({ skabelon });

  const central = (await listCentralForUser(userId)).find((c) => c.id === id.toLowerCase());
  if (!central) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });
  await setCentralDefault(userId, central.id);
  return NextResponse.json({ centralSkabelon: { ...central, isDefault: true } });
});

import { NextRequest, NextResponse } from 'next/server';
import { setDefaultSkabelon } from '@/lib/skabeloner/server';
import { withHandler } from '@/lib/api-handler';
import { requireAppAccess } from '@/lib/authz/app-access';

type Ctx = { params: Promise<{ id: string }> };

// Mark a Skabelon as the user's default (the one preselected in gennemgang).
// A personal preference, not an audited action.
export const POST = withHandler('skabeloner/default', async (_req: NextRequest, { params }: Ctx) => {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const { id } = await params;
  const skabelon = await setDefaultSkabelon(session.user.id, id);
  if (!skabelon) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });
  return NextResponse.json({ skabelon });
});

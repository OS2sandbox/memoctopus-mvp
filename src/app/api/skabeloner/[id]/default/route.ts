import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { setDefaultSkabelon } from '@/lib/skabeloner/server';
import { withHandler } from '@/lib/api-handler';

type Ctx = { params: Promise<{ id: string }> };

// Mark a Skabelon as the user's default (the one preselected in gennemgang).
export const POST = withHandler('skabeloner/default', async (_req: NextRequest, { params }: Ctx) => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const skabelon = await setDefaultSkabelon(session.user.id, id);
  if (!skabelon) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });
  return NextResponse.json({ skabelon });
});

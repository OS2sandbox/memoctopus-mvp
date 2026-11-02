import { NextRequest, NextResponse } from 'next/server';
import { withHandler } from '@/lib/api-handler';
import { requireAppAccess } from '@/lib/authz/app-access';
import { listSkabelonVersions } from '@/lib/skabeloner/server';

type Ctx = { params: Promise<{ id: string }> };

// The person's OWN changelog of one personal template (version, optional note, changed field
// names, time). Own schema only; the notes are not in the audit log and are read by nobody else.
export const GET = withHandler('skabeloner/[id]/history GET', async (_req: NextRequest, { params }: Ctx) => {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;

  const { id } = await params;
  const versions = await listSkabelonVersions(access.session.user.id, id);
  if (!versions) return NextResponse.json({ error: 'Ikke fundet' }, { status: 404 });
  return NextResponse.json({ versions }, { headers: { 'Cache-Control': 'no-store' } });
});

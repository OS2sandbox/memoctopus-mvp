import { NextResponse } from 'next/server';
import { getShareConfig } from '@/lib/skabeloner/share-config';
import { withHandler } from '@/lib/api-handler';
import { requireAppAccess } from '@/lib/authz/app-access';

// Expose which sharing methods are enabled so the client can show only the
// affordances the admin turned on.
export const GET = withHandler('skabeloner/share-config', async () => {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;
  return NextResponse.json({ share: getShareConfig() });
});

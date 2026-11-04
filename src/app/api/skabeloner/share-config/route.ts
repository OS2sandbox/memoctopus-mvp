import { NextResponse } from 'next/server';
import { requireAppAccess } from '@/lib/authz/app-access';
import { getShareConfig } from '@/lib/skabeloner/share-config';

// Expose which sharing methods are enabled so the client can show only the
// affordances the admin turned on.
export async function GET() {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  return NextResponse.json({ share: getShareConfig() });
}

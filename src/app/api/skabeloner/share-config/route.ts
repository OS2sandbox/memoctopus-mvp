import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getShareConfig } from '@/lib/skabeloner/share-config';

// Expose which sharing methods are enabled so the client can show only the
// affordances the admin turned on.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ share: getShareConfig() });
}

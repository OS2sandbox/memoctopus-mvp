import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchema } from '@/lib/db/user-schema';

export async function DELETE() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await queryUserSchema(
    session.user.id,
    `UPDATE audio_files SET deleted_at = now() WHERE deleted_at IS NULL`,
  );

  return NextResponse.json({ ok: true });
}

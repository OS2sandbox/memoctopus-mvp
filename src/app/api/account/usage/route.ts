import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchema } from '@/lib/db/user-schema';

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [countRow] = await queryUserSchema<{ count: string }>(
    session.user.id,
    `SELECT COUNT(*)::text AS count FROM meetings`,
  );

  const [audioRow] = await queryUserSchema<{ bytes: string; oldest: string | null }>(
    session.user.id,
    `SELECT COALESCE(SUM(file_size_bytes), 0)::text AS bytes,
            MIN(m.created_at)::text AS oldest
     FROM audio_files af
     JOIN meetings m ON m.id = af.meeting_id
     WHERE af.deleted_at IS NULL`,
  );

  return NextResponse.json({
    meetingCount: parseInt(countRow?.count ?? '0', 10),
    audioBytes: parseInt(audioRow?.bytes ?? '0', 10),
    oldestMeeting: audioRow?.oldest ?? null,
  });
}

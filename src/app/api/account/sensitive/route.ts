import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchema } from '@/lib/db/user-schema';

export async function DELETE() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Fetch all non-redacted meeting IDs
  const meetings = await queryUserSchema<{ id: string }>(
    session.user.id,
    `SELECT id FROM meetings WHERE status != 'redacted' ORDER BY created_at`,
  );

  let processed = 0;
  for (const m of meetings) {
    await queryUserSchema(
      session.user.id,
      `UPDATE transcripts
       SET raw_text = '',
           segments = '[]'::jsonb,
           pii_removed_at = now()
       WHERE meeting_id = $1`,
      [m.id],
    );
    await queryUserSchema(
      session.user.id,
      `UPDATE audio_files SET deleted_at = now() WHERE meeting_id = $1 AND deleted_at IS NULL`,
      [m.id],
    );
    await queryUserSchema(
      session.user.id,
      `UPDATE meetings SET status = 'redacted', redacted_at = now(), redacted_by = 'user' WHERE id = $1`,
      [m.id],
    );
    processed++;
  }

  return NextResponse.json({ processed, total: meetings.length });
}

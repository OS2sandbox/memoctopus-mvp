import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withHandler } from '@/lib/api-handler';
import { secretEquals } from '@/lib/audit/feed-auth';
import { recordServerEvent } from '@/lib/audit/record';
import { CODE_RE } from '@/lib/audit/events/types';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';

// Called by the bot service when a session ends or fails (joining is not reported: it is not audited). Authenticated
// like /api/bot/audio-upload (BOT_INTERNAL_SECRET), not by a user session. The
// body carries only ids and a short code, never the meeting URL or any name.
const bodySchema = z
  .object({
    userId: z.string().min(1).max(128),
    meetingId: z.string().uuid(),
    event: z.enum(['ended', 'error']),
    code: z.string().regex(CODE_RE).optional(),
  })
  .strict();

function authorised(header: string | null): boolean {
  const secret = process.env.BOT_INTERNAL_SECRET;
  // Same constant-time comparison as /api/bot/audio-upload (both sides are hashed first).
  return !!secret && !!header && secretEquals(header, `Bearer ${secret}`);
}

export const POST = withHandler('bot/lifecycle', async (req: NextRequest) => {
  if (!authorised(req.headers.get('Authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { userId, meetingId, event, code } = parsed.data;

  // The actor is only recorded when the user exists; an unknown id would otherwise
  // plant an arbitrary string in actor_user_id.
  const found = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  const actorUserId = found[0]?.id ?? null;

  const base = { source: 'system' as const, actorUserId, entityId: meetingId };
  if (event === 'ended') {
    await recordServerEvent(req, { type: 'bot.ended', ...base, details: code ? { reason: code } : {} });
  } else {
    await recordServerEvent(req, { type: 'bot.error', ...base, details: { code: code ?? 'unknown' } });
  }
  return NextResponse.json({ ok: true });
});

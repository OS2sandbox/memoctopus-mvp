import { NextRequest, NextResponse } from 'next/server';
import { getBotServiceConfig, botFetch } from '@/lib/bot-service';
import { assertBotMeetingOwner } from '@/lib/bot-pending-audio';
import { withHandler } from '@/lib/api-handler';
import { recordServerEvent } from '@/lib/audit/record';
import { safeLogError } from '@/lib/audit/safe-log';
import { asEntityUuid } from '@/app/api/meetings/ai-audit';
import { z } from 'zod';
import { requireAppAccess } from '@/lib/authz/app-access';
import { recordAuthzDenied } from '@/lib/audit/authz-denied';

const bodySchema = z.object({
  action: z.enum(['pause', 'resume', 'stop', 'abort']),
  // The bot-service issues UUID session ids; anything else could rewrite the path we call there.
  sessionId: z.string().uuid().optional(),
});

const EVENT_FOR_ACTION = {
  pause: 'bot.session_pause',
  resume: 'bot.session_resume',
  stop: 'bot.session_stop',
  abort: 'bot.session_abort',
} as const;

// Pause/resume/stop/abort a Teams bot session. Stateless: the client supplies the
// sessionId (from its IndexedDB meeting record). No DB.
export const POST = withHandler(
  'bot/control',
  async (
    req: NextRequest,
    { params }: { params: Promise<{ meetingId: string }> },
  ) => {
    const access = await requireAppAccess();
    if (access instanceof NextResponse) return access;
    const { session } = access;

    const { meetingId } = await params;

    // Only the user who started this meeting's session may control it. Without this,
    // any authenticated user could stop/pause/abort another user's live recording by
    // supplying their (client-held) sessionId. Deny by default on an unbound meetingId.
    if (!(await assertBotMeetingOwner(meetingId, session.user.id))) {
      await recordAuthzDenied({
        req,
        actorUserId: session.user.id,
        required: 'bot.meeting_owner',
        reason: 'not_owner',
        entityType: 'meeting',
        entityId: meetingId,
      });
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

    const { action, sessionId } = parsed.data;
    const audit = (outcome: 'success' | 'error') =>
      recordServerEvent(req, {
        type: EVENT_FOR_ACTION[action],
        outcome,
        actorUserId: session.user.id,
        entityId: asEntityUuid(meetingId),
      });

    const bot = getBotServiceConfig();
    if (!bot) {
      return NextResponse.json({ error: 'Bot service not configured' }, { status: 503 });
    }

    // Abort: tear down the session if one exists. Idempotent — ok even with no session.
    if (action === 'abort') {
      if (sessionId) {
        await botFetch(bot, `/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch((err) => {
          safeLogError('bot/control abort DELETE failed (ignored, idempotent)', err);
        });
      }
      await audit('success');
      return NextResponse.json({ ok: true });
    }

    if (!sessionId) {
      return NextResponse.json({ error: 'No active bot session' }, { status: 400 });
    }

    const botPath = `/sessions/${encodeURIComponent(sessionId)}/${action}`;

    let res: Response;
    try {
      res = await botFetch(bot, botPath, { method: 'POST' });
    } catch (err) {
      safeLogError(`bot/control action="${action}" network error`, err);
      await audit('error');
      return NextResponse.json({ error: 'Bot control failed' }, { status: 502 });
    }
    if (!res.ok) {
      console.error(`[bot/control] bot rejected action="${action}" with status ${res.status}`);
      await audit('error');
      return NextResponse.json({ error: 'Bot control failed' }, { status: 502 });
    }

    await audit('success');
    return NextResponse.json({ ok: true });
  },
);

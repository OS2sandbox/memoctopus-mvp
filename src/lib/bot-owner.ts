import type { HeaderSource } from '@/lib/audit/request-context';
import { recordAuthzDenied } from '@/lib/audit/authz-denied';
import { assertBotMeetingOwner } from '@/lib/bot-pending-audio';

/**
 * Deny-by-default owner check for the client-facing bot routes. True when this user does NOT own the
 * meeting (an unbound or expired id included): the probe is recorded as authz.denied and the route
 * answers with its own neutral response, so a stranger cannot tell whether a recording exists.
 */
export async function denyUnlessBotOwner(req: HeaderSource, meetingId: string, userId: string): Promise<boolean> {
  if (await assertBotMeetingOwner(meetingId, userId)) return false;
  await recordAuthzDenied({
    req,
    actorUserId: userId,
    required: 'bot.meeting_owner',
    reason: 'not_owner',
    entityType: 'meeting',
    entityId: meetingId,
  });
  return true;
}

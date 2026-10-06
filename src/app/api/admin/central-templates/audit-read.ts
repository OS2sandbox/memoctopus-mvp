// Audit trail for a manager reading a central template's PROMPT. Any manager whose
// scope covers the owner unit (an ancestor included) may read and edit a template,
// so reads are made accountable here: `central_template.read`, with the version
// only, never the prompt text. Both endpoints that return prompt text use this one
// helper: the detail (current prompt) and the changelog (historic prompts are the
// same data). The list returns names and metadata only and does not emit.
//
// Coalesced per (actor, template) to one event per 10 minutes so an editor that
// reloads or polls does not flood the log. The map is in memory and per instance:
// with several instances the rate is at most one event per instance per window,
// and a restart resets it (best-effort, see src/lib/audit/coalesce.ts).
// Best-effort too: recordServerEvent never throws, and this helper swallows
// anything else, so an audit failure can never break the read.
import { createCoalescer } from '@/lib/audit/coalesce';
import { recordServerEvent } from '@/lib/audit/record';
import type { HeaderSource } from '@/lib/audit/request-context';
import { safeLogError } from '@/lib/audit/safe-log';

const WINDOW_MS = 10 * 60 * 1000;

export const promptReadCoalescer = createCoalescer({ windowMs: WINDOW_MS, maxEntries: 10_000, now: () => Date.now() });

/** NUL-joined so no actor/template pair can collide with another. */
export const promptReadKey = (actorUserId: string, templateId: string): string =>
  `${actorUserId}\u0000${templateId.toLowerCase().slice(0, 64)}`;

export async function auditPromptRead(
  req: HeaderSource,
  actorUserId: string,
  template: { id: string; version: number; ownerOrgUnitUuid?: string },
): Promise<void> {
  try {
    if (!promptReadCoalescer.shouldEmit(promptReadKey(actorUserId, template.id))) return;
    await recordServerEvent(req, {
      type: 'central_template.read',
      actorUserId,
      entityId: template.id,
      ...(template.ownerOrgUnitUuid ? { secondaryEntityId: template.ownerOrgUnitUuid } : {}),
      details: { version: template.version },
    });
  } catch (err) {
    safeLogError('central_template.read audit failed', err);
  }
}

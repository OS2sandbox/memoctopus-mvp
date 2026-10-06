import { NextRequest, NextResponse } from 'next/server';
import { generateReferatBody, SkabelonSpec } from '@/lib/ai/minutes';
import { getSkabelon, getDefaultSkabelon } from '@/lib/skabeloner/server';
import { resolveCentralTemplate, type ResolvedCentralTemplate } from '@/lib/skabeloner/resolve';
import type { TemplateRef } from '@/lib/skabeloner/central-types';
import { TranscriptChapter } from '@/lib/ai/chapters';
import { TranscriptSegment, Skabelon } from '@/types';
import { withHandler } from '@/lib/api-handler';
import { asEntityUuid, elapsedMs, emitAudit, outcomeCodeOf } from '@/app/api/meetings/ai-audit';
import { sanitizeChapters, sanitizeParticipants, redactPromptEchoDeep } from '@/lib/ai/prompt-echo';
import { requireAppAccess } from '@/lib/authz/app-access';

export const maxDuration = 120;

async function postHandler(req: NextRequest) {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const body = await req.json();
  const {
    segments,
    participants,
    chapters,
    skabelonId,
    skabelonSource,
    customPrompt,
    includeDeltagere,
    includeBeslutningspunkter,
    includeDagsorden,
    includeDato,
    meetingId,
  } = body as {
    segments: TranscriptSegment[];
    participants?: string[];
    chapters?: TranscriptChapter[];
    skabelonId?: string;
    skabelonSource?: unknown;
    customPrompt?: string;
    includeDeltagere?: boolean;
    includeBeslutningspunkter?: boolean;
    includeDagsorden?: boolean;
    includeDato?: boolean;
    meetingId?: string;
  };

  if (!segments || segments.length === 0) {
    return NextResponse.json({ error: 'No segments provided' }, { status: 400 });
  }

  if (skabelonSource !== undefined && skabelonSource !== 'personal' && skabelonSource !== 'central') {
    return NextResponse.json({ error: 'Ugyldig skabelonkilde' }, { status: 400 });
  }

  const userId = session.user.id;

  // Central (locked) templates are enforced here, never by the client: the STORED
  // prompt and flags are used, and the client's customPrompt / include* overrides
  // only count when the template explicitly allows them. One identical 404 for
  // unknown, archived and not-a-recipient, so existence does not leak.
  let central: ResolvedCentralTemplate | null = null;
  if (skabelonSource === 'central') {
    central = typeof skabelonId === 'string' ? await resolveCentralTemplate(userId, skabelonId) : null;
    if (!central) {
      return NextResponse.json({ error: 'Skabelonen er ikke tilgængelig' }, { status: 404 });
    }
  }

  // An explicit empty skabelonId ('') means the user chose "Ingen skabelon" — no
  // skabelon prompt at all. Omitting the field entirely falls back to the default.
  let skabelon: Skabelon | null = null;
  let templateSource: 'personal' | 'default' | 'none' | 'central' = 'none';
  if (central) {
    templateSource = 'central';
  } else if (skabelonId) {
    skabelon = await getSkabelon(userId, skabelonId);
    templateSource = 'personal';
    // A non-empty id that no longer resolves (deleted/stale in another tab) falls
    // back to the default rather than silently generating with an empty prompt.
    if (!skabelon) {
      skabelon = await getDefaultSkabelon(userId);
      templateSource = 'default';
    }
  } else if (skabelonId === undefined) {
    skabelon = await getDefaultSkabelon(userId);
    templateSource = 'default';
  }
  if (!central && !skabelon) templateSource = 'none';

  // Toggle overrides from the gennemgang UI win over the Skabelon defaults;
  // when neither is set we fall back to the Skabelon's own flags.
  const base = central ?? skabelon;
  // A locked template takes the client's flag only when it allows overrides.
  const pick = (override: boolean | undefined, stored: boolean | undefined): boolean =>
    central
      ? central.allowToggleOverrides && typeof override === 'boolean'
        ? override
        : (stored ?? false)
      : (override ?? stored ?? false);
  const spec: SkabelonSpec = {
    prompt: base?.prompt ?? '',
    includeDeltagere: pick(includeDeltagere, base?.includeDeltagere),
    includeBeslutningspunkter: pick(includeBeslutningspunkter, base?.includeBeslutningspunkter),
    includeDagsorden: pick(includeDagsorden, base?.includeDagsorden),
    includeDato: pick(includeDato, base?.includeDato),
  };
  const effectiveCustomPrompt = central && !central.allowUserInstruction ? undefined : customPrompt;

  const templateId = central?.id ?? skabelon?.id ?? null;
  const templateRef: TemplateRef = central
    ? { source: 'central', id: central.id, version: central.version }
    : { source: templateSource === 'none' ? 'none' : 'personal', id: skabelon?.id ?? null, version: null };

  // Metadata only: ids, counts and a duration. The meeting id is client-supplied
  // and unverified, so it is used only when it is a well-formed UUID.
  const audit = (outcome: 'success' | 'error', t0: number, code?: string) =>
    emitAudit(req, {
      type: 'minutes.generate',
      actorUserId: userId,
      outcome,
      entityId: asEntityUuid(meetingId),
      secondaryEntityId: asEntityUuid(templateId),
      ...(central ? { secondaryEntityType: 'central_template' } : {}),
      details: {
        templateSource,
        ...(central ? { templateVersion: central.version } : {}),
        durationMs: elapsedMs(t0),
        segmentCount: Array.isArray(segments) ? segments.length : 0,
        ...(code ? { outcomeCode: code } : {}),
      },
    });

  // Locked templates (best effort, see src/lib/ai/prompt-echo.ts): client strings
  // that reach the instruction are flattened, the prompt goes in the system message
  // (via `confidential`), and the output is scrubbed for verbatim prompt echoes.
  const safeParticipants = central ? sanitizeParticipants(participants) : participants;
  const safeChapters = central ? sanitizeChapters(chapters) : chapters;

  const t0 = Date.now();
  let content;
  try {
    content = await generateReferatBody(
      segments,
      spec,
      safeParticipants,
      safeChapters,
      effectiveCustomPrompt,
      central ? { confidential: true } : undefined,
    );
  } catch (err) {
    await audit('error', t0, outcomeCodeOf(err));
    throw err;
  }

  let echoed = false;
  if (central) {
    // Nothing about the matched text is logged or returned: only the flag.
    const scrubbed = redactPromptEchoDeep(content, central.prompt);
    content = scrubbed.value;
    echoed = scrubbed.redacted;
  }
  await audit('success', t0, echoed ? 'prompt_echo' : undefined);

  return NextResponse.json({ content, skabelonId: templateId, templateRef });
}

export const POST = withHandler('minutes', postHandler);

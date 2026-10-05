import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { generateReferatBody, SkabelonSpec } from '@/lib/ai/minutes';
import { getSkabelon, getDefaultSkabelon } from '@/lib/skabeloner/server';
import { TranscriptChapter } from '@/lib/ai/chapters';
import { TranscriptSegment, Skabelon } from '@/types';
import { withHandler } from '@/lib/api-handler';
import { asEntityUuid, elapsedMs, emitAudit, outcomeCodeOf } from '@/app/api/meetings/ai-audit';

export const maxDuration = 120;

async function postHandler(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const {
    segments,
    participants,
    chapters,
    skabelonId,
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

  const userId = session.user.id;
  // An explicit empty skabelonId ('') means the user chose "Ingen skabelon" — no
  // skabelon prompt at all. Omitting the field entirely falls back to the default.
  let skabelon: Skabelon | null = null;
  let templateSource: 'personal' | 'default' | 'none' = 'none';
  if (skabelonId) {
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
  if (!skabelon) templateSource = 'none';

  // Toggle overrides from the gennemgang UI win over the Skabelon defaults;
  // when neither is set we fall back to the Skabelon's own flags.
  const spec: SkabelonSpec = {
    prompt: skabelon?.prompt ?? '',
    includeDeltagere: includeDeltagere ?? skabelon?.includeDeltagere ?? false,
    includeBeslutningspunkter:
      includeBeslutningspunkter ?? skabelon?.includeBeslutningspunkter ?? false,
    includeDagsorden: includeDagsorden ?? skabelon?.includeDagsorden ?? false,
    includeDato: includeDato ?? skabelon?.includeDato ?? false,
  };

  // Metadata only: ids, counts and a duration. The meeting id is client-supplied
  // and unverified, so it is used only when it is a well-formed UUID.
  const audit = (outcome: 'success' | 'error', t0: number, code?: string) =>
    emitAudit(req, {
      type: 'minutes.generate',
      actorUserId: userId,
      outcome,
      entityId: asEntityUuid(meetingId),
      secondaryEntityId: asEntityUuid(skabelon?.id),
      details: {
        templateSource,
        durationMs: elapsedMs(t0),
        segmentCount: Array.isArray(segments) ? segments.length : 0,
        ...(code ? { outcomeCode: code } : {}),
      },
    });

  const t0 = Date.now();
  let content;
  try {
    content = await generateReferatBody(segments, spec, participants, chapters, customPrompt);
  } catch (err) {
    await audit('error', t0, outcomeCodeOf(err));
    throw err;
  }
  await audit('success', t0);

  return NextResponse.json({ content, skabelonId: skabelon?.id ?? null });
}

export const POST = withHandler('minutes', postHandler);

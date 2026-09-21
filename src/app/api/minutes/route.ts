import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { generateReferatBody, SkabelonSpec } from '@/lib/ai/minutes';
import { getSkabelon, getDefaultSkabelon } from '@/lib/skabeloner/server';
import { TranscriptChapter } from '@/lib/ai/chapters';
import { TranscriptSegment, Skabelon } from '@/types';
import { withHandler } from '@/lib/api-handler';
import {
  MinutesConfigError,
  MinutesTooLongError,
  MinutesTruncatedError,
} from '@/lib/ai/minutes-errors';

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
  };

  if (!segments || segments.length === 0) {
    return NextResponse.json({ error: 'No segments provided' }, { status: 400 });
  }

  const userId = session.user.id;
  // An explicit empty skabelonId ('') means the user chose "Ingen skabelon" — no
  // skabelon prompt at all. Omitting the field entirely falls back to the default.
  let skabelon: Skabelon | null = null;
  if (skabelonId) {
    skabelon = await getSkabelon(userId, skabelonId);
    // A non-empty id that no longer resolves (deleted/stale in another tab) falls
    // back to the default rather than silently generating with an empty prompt.
    if (!skabelon) skabelon = await getDefaultSkabelon(userId);
  } else if (skabelonId === undefined) {
    skabelon = await getDefaultSkabelon(userId);
  }

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

  let content;
  try {
    content = await generateReferatBody(segments, spec, participants, chapters, customPrompt);
  } catch (err) {
    // Known limits get a message the UI shows as-is (it displays `data.error`); the
    // details go to the server log. Anything else falls through to withHandler's generic 500.
    if (err instanceof MinutesTooLongError) {
      console.error('[minutes]', err);
      return NextResponse.json(
        { error: 'Mødet er for langt til at blive opsummeret med den nuværende AI-model. Kontakt administratoren.' },
        { status: 422 },
      );
    }
    if (err instanceof MinutesTruncatedError) {
      console.error('[minutes]', err);
      return NextResponse.json(
        { error: 'Referatet blev ikke færdigt, fordi AI-modellens svargrænse blev nået. Prøv igen med en kortere skabelon, eller kontakt administratoren.' },
        { status: 422 },
      );
    }
    if (err instanceof MinutesConfigError) {
      console.error('[minutes]', err);
      return NextResponse.json(
        { error: 'AI-modellens indstillinger tillader ikke at generere et referat. Kontakt administratoren.' },
        { status: 500 },
      );
    }
    throw err;
  }

  return NextResponse.json({ content, skabelonId: skabelon?.id ?? null });
}

export const POST = withHandler('minutes', postHandler);

import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { generateReferatBody, SkabelonSpec } from '@/lib/ai/minutes';
import { getSkabelon, getDefaultSkabelon } from '@/lib/skabeloner/server';
import { TranscriptChapter } from '@/lib/ai/chapters';
import { TranscriptSegment } from '@/types';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
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
  } = body as {
    segments: TranscriptSegment[];
    participants?: string[];
    chapters?: TranscriptChapter[];
    skabelonId?: string;
    customPrompt?: string;
    includeDeltagere?: boolean;
    includeBeslutningspunkter?: boolean;
    includeDagsorden?: boolean;
  };

  if (!segments || segments.length === 0) {
    return NextResponse.json({ error: 'No segments provided' }, { status: 400 });
  }

  const userId = session.user.id;
  const skabelon = skabelonId
    ? await getSkabelon(userId, skabelonId)
    : await getDefaultSkabelon(userId);

  // Toggle overrides from the gennemgang UI win over the Skabelon defaults;
  // when neither is set we fall back to the Skabelon's own flags.
  const spec: SkabelonSpec = {
    prompt: skabelon?.prompt ?? '',
    includeDeltagere: includeDeltagere ?? skabelon?.includeDeltagere ?? false,
    includeBeslutningspunkter:
      includeBeslutningspunkter ?? skabelon?.includeBeslutningspunkter ?? false,
    includeDagsorden: includeDagsorden ?? skabelon?.includeDagsorden ?? false,
  };

  const content = await generateReferatBody(
    segments,
    spec,
    participants,
    chapters,
    customPrompt,
  );

  return NextResponse.json({ content, skabelonId: skabelon?.id ?? null });
}

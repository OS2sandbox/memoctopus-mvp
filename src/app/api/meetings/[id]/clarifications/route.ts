import { NextRequest, NextResponse } from 'next/server';
import { analyzeClarifications } from '@/lib/ai/clarifications';
import { withHandler } from '@/lib/api-handler';
import { safeLogError } from '@/lib/audit/safe-log';
import { requireAppAccess } from '@/lib/authz/app-access';

interface Params {
  params: Promise<{ id: string }>;
}

// Live, non-persisted analysis: given the transcript so far, return a short list
// of things worth clarifying. Called periodically by the recording screen.
async function postHandler(req: NextRequest, _ctx: Params) {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;

  const { transcript } = await req.json() as { transcript?: string };
  if (!transcript?.trim()) return NextResponse.json({ clarifications: [] });

  try {
    const clarifications = await analyzeClarifications(transcript);
    return NextResponse.json({ clarifications });
  } catch (err) {
    // Fails soft (empty result); the log line carries error name/status/code only.
    safeLogError('clarifications route', err);
    return NextResponse.json({ clarifications: [] });
  }
}

export const POST = withHandler('clarifications', postHandler);

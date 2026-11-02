import { NextRequest, NextResponse } from 'next/server';
import { authenticateAddinRequest } from '@/lib/outlook/addin-auth';
import { armFromOutlook, parseWindow } from '@/lib/outlook/arm-from-outlook';
import { addinErrorResponse } from '@/lib/outlook/http';
import { validateTeamsUrl } from '@/lib/teams/url';

/**
 * Arms a Teams meeting from the Outlook add-in, by the join link the pane read
 * from the invitation. Authenticated by the add-in's Entra token instead of a
 * session cookie (see addin-auth.ts); the registration itself is
 * armFromOutlook() (src/lib/outlook/arm-from-outlook.ts).
 */
export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await authenticateAddinRequest(req.headers);
  } catch (err) {
    return addinErrorResponse(err);
  }

  const body = (await req.json().catch(() => null)) as
    | { joinUrl?: unknown; start?: unknown; end?: unknown }
    | null;
  const joinUrl = typeof body?.joinUrl === 'string' ? body.joinUrl.trim() : '';
  const check = validateTeamsUrl(joinUrl);
  if (!check.ok) {
    return NextResponse.json(
      { error: check.reason, message: 'Mødets Teams-link kunne ikke læses.' },
      { status: 400 },
    );
  }
  // The appointment's own times. A recurring series has one onlineMeeting whose
  // window is the series'; without the occurrence, occurrence 2+ falls outside
  // the window the pipeline accepts artifacts in.
  const window = parseWindow(body?.start, body?.end);

  try {
    return NextResponse.json(
      await armFromOutlook(userId, { joinUrl, occurrenceStart: window.start, occurrenceEnd: window.end }),
    );
  } catch (err) {
    return addinErrorResponse(err);
  }
}

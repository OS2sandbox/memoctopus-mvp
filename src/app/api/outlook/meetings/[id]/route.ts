import { NextRequest, NextResponse } from 'next/server';
import { authenticateAddinRequest } from '@/lib/outlook/addin-auth';
import { addinErrorResponse } from '@/lib/outlook/http';
import { unregisterTeamsMeeting } from '@/lib/teams/register';
import { getTeamsMeeting } from '@/lib/teams/store';

/**
 * "Slå fra" in the Outlook add-in: un-arm the meeting and forget it, exactly as
 * the dashboard does. Only for meetings armed from Outlook — one registered in
 * the dashboard lives in that browser too, and is switched off from there. The
 * row is read from the caller's own schema, so another user's id is a 404.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await authenticateAddinRequest(req.headers);
  } catch (err) {
    return addinErrorResponse(err);
  }

  const { id } = await params;
  const row = await getTeamsMeeting(userId, id);
  if (!row || row.origin !== 'outlook') {
    return NextResponse.json(
      { error: 'not_found', message: 'Mødet er ikke slået til fra Outlook.' },
      { status: 404 },
    );
  }

  const { disarmed } = await unregisterTeamsMeeting(userId, row);
  console.log(`[outlook] ${userId} switched off ${id} (disarmed: ${disarmed})`);
  return NextResponse.json({ ok: true, disarmed });
}

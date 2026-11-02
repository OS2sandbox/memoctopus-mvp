import { NextRequest, NextResponse } from 'next/server';
import { authenticateAddinRequest } from '@/lib/outlook/addin-auth';
import { armFromOutlook, parseWindow } from '@/lib/outlook/arm-from-outlook';
import { addinErrorResponse } from '@/lib/outlook/http';
import { createOnlineMeeting } from '@/lib/teams/create-meeting';
import { getMeeting } from '@/lib/teams/meeting-resolver';

/**
 * The add-in's meeting-provider button: create a Teams meeting for the
 * appointment, arm it, and hand back what the pane writes into the invitation.
 * The meeting is the caller's own, so they are its organizer and arming works.
 *
 * Every call creates a NEW meeting: the add-in checks the appointment for one it
 * made before and does not call this again.
 */

const MAX_SUBJECT = 1000;

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await authenticateAddinRequest(req.headers);
  } catch (err) {
    return addinErrorResponse(err);
  }

  const body = (await req.json().catch(() => null)) as
    | { subject?: unknown; start?: unknown; end?: unknown }
    | null;
  const window = parseWindow(body?.start, body?.end);
  if (!window.start || !window.end) {
    return NextResponse.json(
      { error: 'invalid_window', message: 'Mødets start og slut kunne ikke læses.' },
      { status: 400 },
    );
  }
  const subject = typeof body?.subject === 'string' ? body.subject.slice(0, MAX_SUBJECT) : '';

  try {
    const created = await createOnlineMeeting(userId, { subject, start: window.start, end: window.end });
    console.log(`[outlook] ${userId} created Teams meeting ${created.graphMeetingId}`);
    // By id, not by link: a join link can take a moment to become findable.
    const resolved = await getMeeting(userId, created.graphMeetingId);
    const armed = await armFromOutlook(userId, {
      joinUrl: created.joinUrl,
      occurrenceStart: window.start,
      occurrenceEnd: window.end,
      resolved: { ...resolved, joinUrl: resolved.joinUrl || created.joinUrl },
    });
    return NextResponse.json({
      ...armed,
      joinUrl: created.joinUrl,
      meetingCode: created.meetingCode,
      passcode: created.passcode,
    });
  } catch (err) {
    return addinErrorResponse(err);
  }
}

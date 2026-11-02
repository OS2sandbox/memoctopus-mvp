import { graphJson } from './graph-client';

/**
 * Creating a Teams meeting for the Outlook add-in's meeting-provider button:
 * POST /me/onlineMeetings, on the delegated OnlineMeetings.ReadWrite scope the
 * integration already has. The caller then arms and registers it like any other.
 *
 * The meeting is the user's own, with them as organizer, so arming it always
 * works. It is not tied to an Outlook calendar item (Graph has no such link for
 * meetings made this way): the add-in writes its link into the invitation.
 */

export interface CreateMeetingInput {
  subject: string;
  start: Date;
  end: Date;
}

export interface CreatedMeeting {
  graphMeetingId: string;
  joinUrl: string;
  /** The numeric meeting id and passcode Teams shows under the link, if any. */
  meetingCode: string | null;
  passcode: string | null;
}

interface GraphCreatedMeeting {
  id?: string | null;
  joinWebUrl?: string | null;
  joinMeetingIdSettings?: { joinMeetingId?: string | null; passcode?: string | null } | null;
}

/** Graph caps the subject; a blank one becomes a neutral default. */
export function meetingSubject(subject: string): string {
  const trimmed = subject.replace(/\s+/g, ' ').trim();
  return (trimmed || 'Teams-møde').slice(0, 255);
}

export async function createOnlineMeeting(userId: string, input: CreateMeetingInput): Promise<CreatedMeeting> {
  const created = await graphJson<GraphCreatedMeeting>(userId, '/me/onlineMeetings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: meetingSubject(input.subject),
      startDateTime: input.start.toISOString(),
      endDateTime: input.end.toISOString(),
    }),
  });
  if (!created?.id || !created.joinWebUrl) {
    throw new Error('Graph created a meeting without an id or a join link');
  }
  return {
    graphMeetingId: created.id,
    joinUrl: created.joinWebUrl,
    meetingCode: created.joinMeetingIdSettings?.joinMeetingId ?? null,
    passcode: created.joinMeetingIdSettings?.passcode ?? null,
  };
}

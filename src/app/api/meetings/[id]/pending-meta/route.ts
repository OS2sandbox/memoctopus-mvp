import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { readPendingMeta, assertMeetingOwner } from '@/lib/pending-artifacts';
import { withHandler } from '@/lib/api-handler';

// Tells the client what a server-side run produced, so the meeting record can be
// filled in before Gennemgang opens. It carries no audio and never will: Graph
// publishes nothing until a meeting has ended, so the raw recording is transcribed
// server-side and dropped rather than handed to a browser that could not have
// followed the meeting live anyway.
//
//   404 → the run has not finished yet — keep polling
//   200 → { status: 'no-recording', participants, durationSeconds }
//
// `participants` is the payload that matters. Teams' transcript names every
// speaker, and those names pre-fill the participant list in Gennemgang. The
// transcript itself comes from the sibling pending-transcript route.
//
// Reading does not delete the record: it is removed together with the transcript,
// when the browser acknowledges that one (DELETE on pending-transcript), or by the
// TTL sweep. So a reload after this read finds the names again.
//
// Wrapped in withHandler so that assertSafeId throwing on an invalid meetingId
// returns a parseable JSON 500 instead of a bare HTML error page.
export const GET = withHandler(
  'meetings/pending-meta',
  async (
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id: meetingId } = await params;

    // Only the user this meeting was registered by may read it. Answer exactly like
    // "not finished yet" so a non-owner cannot detect that a run exists.
    if (!(await assertMeetingOwner(meetingId, session.user.id))) {
      return NextResponse.json({ status: 'pending' }, { status: 404 });
    }

    const meta = await readPendingMeta(meetingId);
    if (!meta) return NextResponse.json({ status: 'pending' }, { status: 404 });

    return NextResponse.json({
      status: 'no-recording',
      participants: meta.participants ?? [],
      durationSeconds: meta.durationSeconds ?? null,
    });
  },
);

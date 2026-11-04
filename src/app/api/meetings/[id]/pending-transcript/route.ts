import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import {
  readPendingTranscript,
  acknowledgePendingTranscript,
  assertMeetingOwner,
} from '@/lib/pending-artifacts';
import { withHandler } from '@/lib/api-handler';
import { deleteRecordingEnabled } from '@/lib/teams/artifact-mode';
import { isSafeMeetingId } from '@/lib/teams/meeting-id';
import { queueRecordingCleanup } from '@/lib/teams/store';

// Client collects the server-side transcription of a Teams meeting (written by the
// Graph pipeline once Teams has published the meeting's artifacts).
//
//   { status: 'none' }                → no server-side run for this meeting — the
//                                       client drives transcription itself
//   { status: 'processing' }          → still working — poll again shortly
//   { status: 'failed' }              → server-side run failed — client fallback
//   { status: 'ready', segments, diarized } → done. Reading does NOT delete it: the
//                                       browser saves it to IndexedDB and then calls
//                                       DELETE below, so a reload or a lost response
//                                       in between costs nothing. A ready transcript
//                                       can be fetched any number of times until then.
//
// A 'failed' stash is not deleted on read either: a retry has to read the same
// verdict. The sweep (pending-sweeper.ts) bounds how long any of them stays.
//
// Wrapped in withHandler, and an invalid id is answered 400 up front, so the
// client's res.json() never meets an HTML error page.
export const GET = withHandler(
  'meetings/pending-transcript',
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id: meetingId } = await params;
    if (!isSafeMeetingId(meetingId)) {
      return NextResponse.json({ error: 'invalid-meeting-id' }, { status: 400 });
    }

    // Only the meeting's owner may read its server-side transcript. A non-owner gets
    // the same "no server-side run" response a stranger meetingId would yield, so the
    // transcript is never exposed.
    if (!(await assertMeetingOwner(meetingId, session.user.id))) {
      return NextResponse.json({ status: 'none' });
    }

    const transcript = await readPendingTranscript(meetingId);
    if (!transcript) return NextResponse.json({ status: 'none' });

    if (transcript.status === 'processing') {
      return NextResponse.json({ status: 'processing' }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (transcript.status === 'failed') return NextResponse.json({ status: 'failed' });

    return NextResponse.json({
      status: 'ready',
      segments: transcript.segments ?? [],
      diarized: transcript.diarized ?? false,
    });
  },
);

// The browser has saved the transcript into IndexedDB: drop the server copy. The
// only thing that deletes a ready transcript, apart from the TTL sweep.
//
// It is also the one moment the recording the transcript was made from may leave
// the organizer's OneDrive: until now the transcript existed only in a server copy
// that expires, and the recording is what a re-collect transcribes again. The
// delete is queued in the caller's own schema, so it can only touch their own
// meeting, and the poller carries it out on its next tick. It is queued even when
// the server copy has already expired: the browser saved it all the same.
//
// Idempotent, and answers { ok: true } for a stranger's meetingId too, so nothing
// tells a non-owner whether a run exists (they simply delete nothing).
export const DELETE = withHandler(
  'meetings/pending-transcript',
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id: meetingId } = await params;
    const userId = session.user.id;
    // False only for a stale acknowledgement while a re-collect is running.
    const acknowledged = (await assertMeetingOwner(meetingId, userId))
      ? await acknowledgePendingTranscript(meetingId)
      : true;
    if (acknowledged && deleteRecordingEnabled()) {
      await queueRecordingCleanup(userId, meetingId);
    }
    return NextResponse.json({ ok: true });
  },
);

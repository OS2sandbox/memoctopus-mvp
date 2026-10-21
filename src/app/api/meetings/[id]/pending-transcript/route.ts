import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import {
  readPendingTranscript,
  deletePendingTranscript,
  acknowledgePendingTranscript,
  assertMeetingOwner,
} from '@/lib/pending-artifacts';
import { withHandler } from '@/lib/api-handler';

// Client collects the server-side transcription of a Teams-bot recording
// (kicked off by the Graph pipeline as soon as it has the recording).
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
// A 'failed' stash carries nothing worth keeping, so that one is dropped as it is read.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: meetingId } = await params;

  // Only the meeting's owner may read its server-side transcript. A non-owner gets
  // the same "no server-side run" response a stranger meetingId would yield, so the
  // transcript is never exposed and a failed stash is never deleted for a stranger.
  if (!(await assertMeetingOwner(meetingId, session.user.id))) {
    return NextResponse.json({ status: 'none' });
  }

  const transcript = await readPendingTranscript(meetingId);
  if (!transcript) return NextResponse.json({ status: 'none' });

  if (transcript.status === 'processing') {
    return NextResponse.json({ status: 'processing' }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (transcript.status === 'failed') {
    await deletePendingTranscript(meetingId);
    return NextResponse.json({ status: 'failed' });
  }
  return NextResponse.json({
    status: 'ready',
    segments: transcript.segments ?? [],
    diarized: transcript.diarized ?? false,
  });
}

// The browser has saved the transcript into IndexedDB: drop the server copy. The
// only thing that deletes a ready transcript, apart from the TTL sweep.
//
// Idempotent, and answers { ok: true } for a stranger's meetingId too, so nothing
// tells a non-owner whether a run exists (they simply delete nothing).
export const DELETE = withHandler(
  'meetings/pending-transcript',
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id: meetingId } = await params;
    if (await assertMeetingOwner(meetingId, session.user.id)) {
      await acknowledgePendingTranscript(meetingId);
    }
    return NextResponse.json({ ok: true });
  },
);

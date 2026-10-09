import { NextRequest, NextResponse } from 'next/server';
import { withHandler } from '@/lib/api-handler';
import { readPendingTranscript, deletePendingTranscript } from '@/lib/bot-pending-audio';
import { denyUnlessBotOwner } from '@/lib/bot-owner';
import { requireAppAccess } from '@/lib/authz/app-access';

// Client collects the server-side transcription of a Teams-bot recording
// (kicked off by /api/bot/audio-upload the moment the bot uploaded the audio).
//
//   { status: 'none' }                → no server-side run for this meeting — the
//                                       client drives transcription itself
//   { status: 'processing' }          → still working — poll again shortly
//   { status: 'failed' }              → server-side run failed — client fallback
//   { status: 'ready', segments, diarized } → done; the stash is deleted on hand-off
export const GET = withHandler('bot/transcript', async (
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) => {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const { meetingId } = await params;

  // Only the meeting's owner may read its server-side transcript. A non-owner gets
  // the same "no server-side run" response a stranger meetingId would yield, so the
  // transcript is never exposed and the destructive delete below is never reached.
  if (await denyUnlessBotOwner(req, meetingId, session.user.id)) {
    return NextResponse.json({ status: 'none' });
  }

  const transcript = await readPendingTranscript(meetingId);
  if (!transcript) return NextResponse.json({ status: 'none' });

  if (transcript.status === 'processing') {
    return NextResponse.json({ status: 'processing' }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // The server-held copy goes as soon as the browser has it; the deletion is recorded (when it held text).
  await deletePendingTranscript(meetingId, { trigger: 'handoff', actorUserId: session.user.id, req });
  if (transcript.status === 'failed') return NextResponse.json({ status: 'failed' });
  return NextResponse.json({
    status: 'ready',
    segments: transcript.segments ?? [],
    diarized: transcript.diarized ?? false,
  });
});

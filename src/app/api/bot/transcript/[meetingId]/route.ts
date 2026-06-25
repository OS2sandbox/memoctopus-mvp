import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { readPendingTranscript, deletePendingTranscript } from '@/lib/bot-pending-audio';

// Client collects the server-side transcription of a Teams-bot recording
// (kicked off by /api/bot/audio-upload the moment the bot uploaded the audio).
//
//   { status: 'none' }                → no server-side run for this meeting — the
//                                       client drives transcription itself
//   { status: 'processing' }          → still working — poll again shortly
//   { status: 'failed' }              → server-side run failed — client fallback
//   { status: 'ready', segments, diarized } → done; the stash is deleted on hand-off
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { meetingId } = await params;
  const transcript = await readPendingTranscript(meetingId);
  if (!transcript) return NextResponse.json({ status: 'none' });

  if (transcript.status === 'processing') {
    return NextResponse.json({ status: 'processing' }, { headers: { 'Cache-Control': 'no-store' } });
  }

  await deletePendingTranscript(meetingId);
  if (transcript.status === 'failed') {
    return NextResponse.json({ status: 'failed' });
  }
  return NextResponse.json({
    status: 'ready',
    segments: transcript.segments ?? [],
    diarized: transcript.diarized ?? false,
  });
}

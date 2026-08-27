import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { readPendingMeta, readPendingAudio, deletePendingAudio } from '@/lib/bot-pending-audio';

// Client pulls down a finished Teams-bot recording so it can be saved into IndexedDB
// and transcribed client-side. The bot stashes audio here via /api/bot/audio-upload.
//
//   404 → not ready yet (bot still recording / uploading) — keep polling
//   200 + JSON { status: 'no-recording' } → bot finished with nothing to transcribe
//   200 + audio body → the recording (with X-Participants / X-Duration headers)
//
// The stashed copy is deleted as soon as it is handed to the client.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { meetingId } = await params;

  const meta = await readPendingMeta(meetingId);
  if (!meta) return NextResponse.json({ status: 'pending' }, { status: 404 });

  if (!meta.hasRecording) {
    await deletePendingAudio(meetingId);
    return NextResponse.json({ status: 'no-recording' });
  }

  const buffer = await readPendingAudio(meetingId);
  if (!buffer) return NextResponse.json({ status: 'pending' }, { status: 404 });

  await deletePendingAudio(meetingId);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': meta.mimeType || 'audio/webm',
      'Content-Length': String(buffer.byteLength),
      'X-Participants': encodeURIComponent(JSON.stringify(meta.participants ?? [])),
      'X-Duration': meta.durationSeconds != null ? String(meta.durationSeconds) : '',
      'Cache-Control': 'no-store',
    },
  });
}

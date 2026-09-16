import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { readPendingMeta, readPendingAudio, deletePendingAudio, assertBotMeetingOwner } from '@/lib/bot-pending-audio';
import { withHandler } from '@/lib/api-handler';

// Client pulls down a finished Teams-bot recording so it can be saved into IndexedDB
// and transcribed client-side. The bot stashes audio here via /api/bot/audio-upload.
//
//   404 → not ready yet (bot still recording / uploading) — keep polling
//   200 + JSON { status: 'no-recording', participants, durationSeconds }
//        → finished with nothing to transcribe (bot never admitted, or a Teams
//          transcript-only meeting where the transcript is the whole result)
//   200 + audio body → the recording (with X-Participants / X-Duration headers)
//
// The stashed copy is deleted as soon as it is handed to the client.
//
// Wrapped in withHandler so that assertSafeId throwing on an invalid meetingId
// returns a parseable JSON 500 instead of a bare HTML error page.
export const GET = withHandler(
  'bot/audio',
  async (
    _req: NextRequest,
    { params }: { params: Promise<{ meetingId: string }> },
  ) => {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { meetingId } = await params;

    // Only the user who started this meeting's bot session may pull its recording.
    // Respond exactly like "not ready yet" so a non-owner can't even detect that a
    // recording exists (and never reaches the destructive read/delete below).
    if (!(await assertBotMeetingOwner(meetingId, session.user.id))) {
      return NextResponse.json({ status: 'pending' }, { status: 404 });
    }

    const meta = await readPendingMeta(meetingId);
    if (!meta) return NextResponse.json({ status: 'pending' }, { status: 404 });

    if (!meta.hasRecording) {
      await deletePendingAudio(meetingId);
      // Participants still matter with no audio: a Teams transcript-only meeting
      // knows every speaker's display name, and that is what pre-fills the
      // participant list in Gennemgang.
      return NextResponse.json({
        status: 'no-recording',
        participants: meta.participants ?? [],
        durationSeconds: meta.durationSeconds ?? null,
      });
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
  },
);

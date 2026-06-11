import { NextRequest, NextResponse } from 'next/server';
import { storePendingAudio, markNoRecording } from '@/lib/bot-pending-audio';

// Called by the bot service — authenticated with BOT_INTERNAL_SECRET, not a user session.
//
// The recording is stashed transiently (keyed by meetingId) rather than persisted:
// meetings live in the user's browser IndexedDB, so the client pulls this audio down
// via GET /api/bot/audio/[meetingId] and runs the normal client-side transcription
// pipeline. Nothing is written to a server database.
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('Authorization');
  const secret = process.env.BOT_INTERNAL_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // No-recording notification from bot (JSON, no audio file).
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = await req.json() as { meetingId?: string; hasRecording?: boolean };
    if (!body.meetingId || body.hasRecording !== false) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    await markNoRecording(body.meetingId).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  const meetingId = formData.get('meetingId') as string | null;
  const durationStr = formData.get('duration') as string | null;
  const participantsJson = formData.get('participants') as string | null;

  if (!audioFile || !meetingId) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const mimeType = audioFile.type || 'audio/webm';
  if (!mimeType.startsWith('audio/') && !mimeType.startsWith('video/webm')) {
    return NextResponse.json({ error: 'Invalid audio file type' }, { status: 400 });
  }

  let participants: string[] = [];
  if (participantsJson) {
    try {
      const parsed = JSON.parse(participantsJson);
      if (Array.isArray(parsed)) participants = parsed.filter((p) => typeof p === 'string');
    } catch { /* non-fatal */ }
  }

  const durationSeconds = durationStr ? Math.max(0, parseInt(durationStr, 10) || 0) : null;
  const buffer = Buffer.from(await audioFile.arrayBuffer());

  try {
    await storePendingAudio(meetingId, buffer, {
      mimeType,
      participants,
      durationSeconds,
      hasRecording: true,
    });
  } catch (err) {
    console.error('[bot audio-upload] failed to stash audio:', err);
    return NextResponse.json({ error: 'Failed to store audio' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

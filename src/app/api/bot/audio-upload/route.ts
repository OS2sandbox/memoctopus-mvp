import { NextRequest, NextResponse } from 'next/server';
import { storePendingAudio, storePendingTranscript, markNoRecording, getBotMeetingOwner } from '@/lib/bot-pending-audio';
import { processBotRecording } from '@/lib/bot-transcribe';
import { withHandler } from '@/lib/api-handler';
import { safeLogError } from '@/lib/audit/safe-log';
import { secretEquals } from '@/lib/audit/feed-auth';
import { recordServerEvent } from '@/lib/audit/record';
import { asEntityUuid, outcomeCodeOf } from '@/app/api/meetings/ai-audit';

// Called by the bot service — authenticated with BOT_INTERNAL_SECRET, not a user session.
//
// The recording is stashed transiently (keyed by meetingId) rather than persisted:
// meetings live in the user's browser IndexedDB, so the client pulls this audio down
// via GET /api/bot/audio/[meetingId] and runs the normal client-side transcription
// pipeline. Nothing is written to a server database.
export const POST = withHandler('bot/audio-upload', async (req: NextRequest) => {
  const authHeader = req.headers.get('Authorization');
  const secret = process.env.BOT_INTERNAL_SECRET;
  if (!secret || !authHeader || !secretEquals(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // No-recording notification from bot (JSON, no audio file).
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = await req.json() as { meetingId?: string; hasRecording?: boolean };
    if (!body.meetingId || body.hasRecording !== false) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    // Log failures: a silently dropped markNoRecording leaves the client polling
    // indefinitely instead of showing the correct cancelled state.
    await markNoRecording(body.meetingId).catch((err) => {
      safeLogError('bot/audio-upload markNoRecording', err);
    });
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
    } catch (err) {
      // Non-fatal: participants list is best-effort metadata; missing it does not block transcription.
      safeLogError('bot/audio-upload participants JSON unparseable (non-fatal)', err);
    }
  }

  const durationSeconds = durationStr ? Math.max(0, parseInt(durationStr, 10) || 0) : null;
  const buffer = Buffer.from(await audioFile.arrayBuffer());

  // Recorded as the system (the bot service is the caller, authenticated by secret). The
  // person it belongs to is the one who started the bot session; unknown when that binding is gone.
  const owner = await getBotMeetingOwner(meetingId).catch(() => null);
  const audit = (outcome: 'success' | 'error', outcomeCode?: string) =>
    recordServerEvent(req, {
      type: 'audio.upload',
      source: 'system',
      outcome,
      actorUserId: owner,
      entityId: asEntityUuid(meetingId),
      details: { channel: 'bot', bytes: buffer.length, ...(outcomeCode ? { outcomeCode } : {}) },
    });

  try {
    await storePendingAudio(meetingId, buffer, {
      mimeType,
      participants,
      durationSeconds,
      hasRecording: true,
    });
  } catch (err) {
    safeLogError('bot/audio-upload stash audio', err);
    await audit('error', outcomeCodeOf(err));
    return NextResponse.json({ error: 'Failed to store audio' }, { status: 500 });
  }

  // Start transcription + diarization NOW, server-side, instead of waiting for the
  // user's browser to poll the audio down and re-upload it. The 'processing' marker
  // is written before responding so the client never races an absent stash; the
  // heavy work itself runs detached (fire-and-forget) — the bot's upload request
  // must not block on minutes of inference, and failures degrade to the client-side
  // fallback path.
  await storePendingTranscript(meetingId, { status: 'processing' }).catch((err) => {
    safeLogError('bot/audio-upload storePendingTranscript', err);
  });
  void processBotRecording(meetingId, buffer, mimeType);
  await audit('success');

  return NextResponse.json({ ok: true });
});

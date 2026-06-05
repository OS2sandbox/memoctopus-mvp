import { after, NextRequest, NextResponse } from 'next/server';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { getTranscriptionProvider } from '@/lib/ai/transcription';
import { detectPiiInSegments } from '@/lib/ai/pii';
import { groupIntoChapters } from '@/lib/ai/chapters';
import { saveAudioFile } from '@/lib/audio/storage';
import type { TranscriptSegment, PiiReplacement } from '@/types';

// Called by the bot service — authenticated with BOT_INTERNAL_SECRET, not a user session.
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('Authorization');
  const secret = process.env.BOT_INTERNAL_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Handle no-recording notification from bot (JSON, no audio file)
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = await req.json() as { meetingId?: string; userId?: string; hasRecording?: boolean };
    if (!body.meetingId || !body.userId || body.hasRecording !== false) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    await queryUserSchemaOne(
      body.userId,
      `UPDATE meetings SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [body.meetingId],
    ).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  const meetingId = formData.get('meetingId') as string | null;
  const userId = formData.get('userId') as string | null;
  const participantsJson = formData.get('participants') as string | null;

  if (!audioFile || !meetingId || !userId) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const mimeType = audioFile.type || 'audio/webm';
  if (!mimeType.startsWith('audio/') && !mimeType.startsWith('video/webm')) {
    return NextResponse.json({ error: 'Invalid audio file type' }, { status: 400 });
  }

  const meeting = await queryUserSchemaOne<{ id: string; status: string }>(
    userId,
    'SELECT id, status FROM meetings WHERE id = $1',
    [meetingId],
  );
  if (!meeting) return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });

  // Read audio into memory now — the File object is tied to this request and won't
  // be available after the response is sent.
  const buffer = Buffer.from(await audioFile.arrayBuffer());
  const originalFilename = audioFile.name || 'recording.webm';

  // Merge detected participants (fast DB write — do before responding).
  if (participantsJson) {
    try {
      const detected: string[] = JSON.parse(participantsJson);
      if (detected.length > 0) {
        await queryUserSchemaOne(
          userId,
          `UPDATE meetings
           SET participants = (
             SELECT array_agg(DISTINCT elem ORDER BY elem)
             FROM unnest(participants || $1::text[]) AS t(elem)
           ),
           updated_at = NOW()
           WHERE id = $2`,
          [detected, meetingId],
        );
      }
    } catch {
      // non-fatal — proceed with transcription
    }
  }

  await queryUserSchemaOne(
    userId,
    `UPDATE meetings SET status = 'processing', updated_at = NOW() WHERE id = $1`,
    [meetingId],
  );

  // Schedule the slow pipeline (save → transcribe → PII → chapters → review) to run
  // after this response is returned. This prevents the bot-service's HTTP request from
  // hitting the proxy timeout (502) while waiting for transcription to finish.
  after(async () => {
    await _processAudio({ buffer, mimeType, meetingId, userId, originalFilename });
  });

  return NextResponse.json({ ok: true });
}

async function _processAudio({
  buffer,
  mimeType,
  meetingId,
  userId,
  originalFilename,
}: {
  buffer: Buffer;
  mimeType: string;
  meetingId: string;
  userId: string;
  originalFilename: string;
}): Promise<void> {
  try {
    const { filename, sizeBytes } = await saveAudioFile(userId, buffer, originalFilename);
    await queryUserSchemaOne(
      userId,
      `INSERT INTO audio_files (meeting_id, filename, size_bytes) VALUES ($1, $2, $3)`,
      [meetingId, filename, sizeBytes],
    );

    const provider = getTranscriptionProvider();
    const rawSegments: TranscriptSegment[] = await provider.transcribe(buffer, mimeType);

    let piiReplacements: PiiReplacement[] = [];
    try {
      const piiResult = await detectPiiInSegments(rawSegments);
      piiReplacements = piiResult.replacements;
    } catch (piiErr) {
      console.error('Bot audio PII detection failed (non-fatal):', piiErr);
    }

    let chapters: Awaited<ReturnType<typeof groupIntoChapters>> = [];
    try {
      chapters = await groupIntoChapters(rawSegments);
    } catch (chapErr) {
      console.error('Bot audio chapters generation failed (non-fatal):', chapErr);
    }

    const rawText = rawSegments.map((s) => s.text).join(' ');

    await queryUserSchemaOne(
      userId,
      `INSERT INTO transcripts (meeting_id, raw_text, segments, pii_removed_at, pii_replacements, chapters)
       VALUES ($1, $2, $3, NULL, $4, $5)`,
      [meetingId, rawText, JSON.stringify(rawSegments), JSON.stringify(piiReplacements), JSON.stringify(chapters)],
    );

    await queryUserSchemaOne(
      userId,
      `UPDATE meetings SET status = 'review', updated_at = NOW() WHERE id = $1`,
      [meetingId],
    );
  } catch (err) {
    console.error('Bot audio transcription error:', err);
    // Even on failure, move to review with an empty transcript so the UI can navigate.
    const inserted = await queryUserSchemaOne(
      userId,
      `INSERT INTO transcripts (meeting_id, raw_text, segments) VALUES ($1, '', '[]')
       ON CONFLICT DO NOTHING
       RETURNING meeting_id`,
      [meetingId],
    ).catch(() => null);
    if (!inserted) {
      console.warn('Bot audio: transcript already exists for meetingId:', meetingId, '— keeping existing');
    }
    await queryUserSchemaOne(
      userId,
      `UPDATE meetings SET status = 'review', updated_at = NOW() WHERE id = $1`,
      [meetingId],
    ).catch(() => {});
  }
}

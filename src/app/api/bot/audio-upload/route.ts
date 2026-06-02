import { NextRequest, NextResponse } from 'next/server';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { getTranscriptionProvider } from '@/lib/ai/transcription';
import { detectPiiInSegments } from '@/lib/ai/pii';
import { saveAudioFile } from '@/lib/audio/storage';
import type { TranscriptSegment } from '@/types';

// Called by the bot service — authenticated with BOT_INTERNAL_SECRET, not a user session.
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('Authorization');
  const secret = process.env.BOT_INTERNAL_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  const meetingId = formData.get('meetingId') as string | null;
  const userId = formData.get('userId') as string | null;
  const participantsJson = formData.get('participants') as string | null;

  if (!audioFile || !meetingId || !userId) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const meeting = await queryUserSchemaOne<{ id: string; status: string }>(
    userId,
    'SELECT id, status FROM meetings WHERE id = $1',
    [meetingId],
  );
  if (!meeting) return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });

  // Merge detected participants into the meeting's participant list
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

  try {
    const buffer = Buffer.from(await audioFile.arrayBuffer());
    const mimeType = audioFile.type || 'audio/webm';

    const { filename, sizeBytes } = await saveAudioFile(userId, buffer, audioFile.name || 'recording.webm');
    await queryUserSchemaOne(
      userId,
      `INSERT INTO audio_files (meeting_id, filename, size_bytes)
       VALUES ($1, $2, $3)`,
      [meetingId, filename, sizeBytes],
    );

    const provider = getTranscriptionProvider();
    const rawSegments: TranscriptSegment[] = await provider.transcribe(buffer, mimeType);

    const { replacements } = await detectPiiInSegments(rawSegments);
    const rawText = rawSegments.map((s) => s.text).join(' ');

    await queryUserSchemaOne(
      userId,
      `INSERT INTO transcripts (meeting_id, raw_text, segments, pii_removed_at, pii_replacements)
       VALUES ($1, $2, $3, NULL, $4)`,
      [meetingId, rawText, JSON.stringify(rawSegments), JSON.stringify(replacements)],
    );

    await queryUserSchemaOne(
      userId,
      `UPDATE meetings SET status = 'review', updated_at = NOW() WHERE id = $1`,
      [meetingId],
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    await queryUserSchemaOne(
      userId,
      `UPDATE meetings SET status = 'recording', updated_at = NOW() WHERE id = $1`,
      [meetingId],
    ).catch(() => {});

    console.error('Bot audio transcription error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Transcription failed' },
      { status: 500 },
    );
  }
}

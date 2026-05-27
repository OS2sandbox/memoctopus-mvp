import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { getTranscriptionProvider } from '@/lib/ai/transcription';
import { removePiiFromSegments } from '@/lib/ai/pii';
import { saveAudioFile } from '@/lib/audio/storage';

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  const meetingId = formData.get('meetingId') as string | null;
  const durationStr = formData.get('duration') as string | null;

  if (!audioFile || !meetingId) {
    return NextResponse.json({ error: 'Missing audio file or meetingId' }, { status: 400 });
  }

  // Verify meeting belongs to user
  const meeting = await queryUserSchemaOne<{ id: string; status: string }>(
    session.user.id,
    'SELECT id, status FROM meetings WHERE id = $1',
    [meetingId],
  );
  if (!meeting) return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });

  // Mark as processing
  await queryUserSchemaOne(
    session.user.id,
    `UPDATE meetings SET status = 'processing', updated_at = NOW() WHERE id = $1`,
    [meetingId],
  );

  try {
    const buffer = Buffer.from(await audioFile.arrayBuffer());
    const mimeType = audioFile.type || 'audio/webm';
    const duration = durationStr ? parseInt(durationStr, 10) : null;

    // Save audio file to disk
    const { filename, sizeBytes } = await saveAudioFile(
      session.user.id,
      buffer,
      audioFile.name,
    );

    // Store audio file record
    await queryUserSchemaOne(
      session.user.id,
      `INSERT INTO audio_files (meeting_id, filename, size_bytes, duration_seconds)
       VALUES ($1, $2, $3, $4)`,
      [meetingId, filename, sizeBytes, duration],
    );

    // Transcribe
    const provider = getTranscriptionProvider();
    const segments = await provider.transcribe(buffer, mimeType);

    // Remove PII
    const { cleanedSegments, replacements } = await removePiiFromSegments(segments);

    const rawText = cleanedSegments.map((s) => s.text).join(' ');

    // Save transcript
    const transcript = await queryUserSchemaOne<{ id: string }>(
      session.user.id,
      `INSERT INTO transcripts (meeting_id, raw_text, segments, pii_removed_at, pii_replacements)
       VALUES ($1, $2, $3, NOW(), $4)
       RETURNING id`,
      [meetingId, rawText, JSON.stringify(cleanedSegments), JSON.stringify(replacements)],
    );

    // Mark meeting as ready for review
    await queryUserSchemaOne(
      session.user.id,
      `UPDATE meetings SET status = 'review', updated_at = NOW() WHERE id = $1`,
      [meetingId],
    );

    return NextResponse.json({
      transcriptId: transcript!.id,
      segments: cleanedSegments,
      piiReplacementCount: replacements.length,
    });
  } catch (err) {
    // On error, reset meeting status
    await queryUserSchemaOne(
      session.user.id,
      `UPDATE meetings SET status = 'recording', updated_at = NOW() WHERE id = $1`,
      [meetingId],
    ).catch(() => {});

    console.error('Transcription error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Transcription failed' },
      { status: 500 },
    );
  }
}

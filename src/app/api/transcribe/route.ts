import { after, NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { getTranscriptionProvider } from '@/lib/ai/transcription';
import { detectPiiInSegments } from '@/lib/ai/pii';
import { saveAudioFile } from '@/lib/audio/storage';
import { TranscriptSegment, PiiReplacement } from '@/types';

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  const meetingId = formData.get('meetingId') as string | null;
  const durationStr = formData.get('duration') as string | null;
  // When provided: the caller already saved a draft transcript (e.g. live-preview
  // segments). The background pipeline will replace those segments with the
  // authoritative batch result rather than inserting a new row.
  const transcriptId = formData.get('transcriptId') as string | null;

  if (!audioFile || !meetingId) {
    return NextResponse.json({ error: 'Missing audio file or meetingId' }, { status: 400 });
  }

  const meeting = await queryUserSchemaOne<{ id: string; status: string }>(
    session.user.id,
    'SELECT id, status FROM meetings WHERE id = $1',
    [meetingId],
  );
  if (!meeting) return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });

  // Read audio into memory now — the File object is tied to this request and
  // won't be available after the response is sent.
  const buffer = Buffer.from(await audioFile.arrayBuffer());
  const mimeType = audioFile.type || 'audio/webm';
  const duration = durationStr ? parseInt(durationStr, 10) : null;
  const userId = session.user.id;

  // Save the audio file synchronously so the file exists on disk before we respond.
  // If this fails we return an error immediately.
  try {
    const { filename, sizeBytes } = await saveAudioFile(userId, buffer, audioFile.name);
    await queryUserSchemaOne(
      userId,
      `INSERT INTO audio_files (meeting_id, filename, size_bytes, duration_seconds)
       VALUES ($1, $2, $3, $4)`,
      [meetingId, filename, sizeBytes, duration],
    );
  } catch (err) {
    console.error('Audio save error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save audio' },
      { status: 500 },
    );
  }

  await queryUserSchemaOne(
    userId,
    `UPDATE meetings SET status = 'processing', updated_at = NOW() WHERE id = $1`,
    [meetingId],
  );

  // Run the slow transcription pipeline after the response is returned so the
  // client can navigate to the review page immediately without waiting.
  after(async () => {
    await _processTranscription({ buffer, mimeType, meetingId, userId, transcriptId });
  });

  return NextResponse.json({ ok: true });
}

async function _processTranscription({
  buffer,
  mimeType,
  meetingId,
  userId,
  transcriptId,
}: {
  buffer: Buffer;
  mimeType: string;
  meetingId: string;
  userId: string;
  transcriptId: string | null;
}): Promise<void> {
  try {
    const provider = getTranscriptionProvider();
    const rawSegments: TranscriptSegment[] = await provider.transcribe(buffer, mimeType);

    let replacements: PiiReplacement[] = [];
    try {
      const piiResult = await detectPiiInSegments(rawSegments);
      replacements = piiResult.replacements;
    } catch (piiErr) {
      console.error('PII detection failed (non-fatal):', piiErr);
    }

    const rawText = rawSegments.map((s) => s.text).join(' ');

    if (transcriptId) {
      // Replace the draft (live-preview) segments with the authoritative batch result.
      await queryUserSchemaOne(
        userId,
        `UPDATE transcripts
         SET raw_text = $1, segments = $2, pii_replacements = $3
         WHERE id = $4`,
        [rawText, JSON.stringify(rawSegments), JSON.stringify(replacements), transcriptId],
      );
    } else {
      await queryUserSchemaOne(
        userId,
        `INSERT INTO transcripts (meeting_id, raw_text, segments, pii_removed_at, pii_replacements)
         VALUES ($1, $2, $3, NULL, $4)`,
        [meetingId, rawText, JSON.stringify(rawSegments), JSON.stringify(replacements)],
      );
    }

    await queryUserSchemaOne(
      userId,
      `UPDATE meetings SET status = 'review', updated_at = NOW() WHERE id = $1`,
      [meetingId],
    );
  } catch (err) {
    console.error('Transcription error:', err);
    // On failure: keep any draft transcript if one exists, otherwise insert an
    // empty placeholder. Always move to 'review' so the user can access the meeting.
    const existing = await queryUserSchemaOne<{ id: string }>(
      userId,
      'SELECT id FROM transcripts WHERE meeting_id = $1 LIMIT 1',
      [meetingId],
    ).catch(() => null);

    if (!existing) {
      await queryUserSchemaOne(
        userId,
        `INSERT INTO transcripts (meeting_id, raw_text, segments) VALUES ($1, '', '[]')`,
        [meetingId],
      ).catch(() => {});
    }

    await queryUserSchemaOne(
      userId,
      `UPDATE meetings SET status = 'review', updated_at = NOW() WHERE id = $1`,
      [meetingId],
    ).catch(() => {});
  }
}

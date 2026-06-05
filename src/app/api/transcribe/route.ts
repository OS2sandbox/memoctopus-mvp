import { NextRequest, NextResponse } from 'next/server';
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
  // When provided: update an existing transcript (audio + PII only, no re-transcription)
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

  // Update mode: transcript already exists (created by save-transcript).
  // Save the audio file, detect PII, patch the transcript — don't change meeting status.
  if (transcriptId) {
    try {
      const buffer = Buffer.from(await audioFile.arrayBuffer());
      const mimeType = audioFile.type || 'audio/webm';
      const duration = durationStr ? parseInt(durationStr, 10) : null;

      const { filename, sizeBytes } = await saveAudioFile(session.user.id, buffer, audioFile.name);
      await queryUserSchemaOne(
        session.user.id,
        `INSERT INTO audio_files (meeting_id, filename, size_bytes, duration_seconds)
         VALUES ($1, $2, $3, $4)`,
        [meetingId, filename, sizeBytes, duration],
      );

      // Load the already-saved segments so PII detection runs on the real transcript
      const existing = await queryUserSchemaOne<{ segments: unknown }>(
        session.user.id,
        'SELECT segments FROM transcripts WHERE id = $1',
        [transcriptId],
      );
      const rawSegments = Array.isArray(existing?.segments)
        ? (existing.segments as TranscriptSegment[])
        : [];

      let replacements: PiiReplacement[] = [];
      try {
        const piiResult = await detectPiiInSegments(rawSegments);
        replacements = piiResult.replacements;
      } catch (piiErr) {
        console.error('PII detection failed (non-fatal):', piiErr);
      }

      await queryUserSchemaOne(
        session.user.id,
        'UPDATE transcripts SET pii_replacements = $1 WHERE id = $2',
        [JSON.stringify(replacements), transcriptId],
      );

      return NextResponse.json({ piiReplacements: replacements });
    } catch (err) {
      console.error('Audio upload error:', err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Upload failed' },
        { status: 500 },
      );
    }
  }

  // Create mode: no existing transcript — full pipeline (transcription + PII).
  await queryUserSchemaOne(
    session.user.id,
    `UPDATE meetings SET status = 'processing', updated_at = NOW() WHERE id = $1`,
    [meetingId],
  );

  try {
    const buffer = Buffer.from(await audioFile.arrayBuffer());
    const mimeType = audioFile.type || 'audio/webm';
    const duration = durationStr ? parseInt(durationStr, 10) : null;

    const { filename, sizeBytes } = await saveAudioFile(session.user.id, buffer, audioFile.name);
    await queryUserSchemaOne(
      session.user.id,
      `INSERT INTO audio_files (meeting_id, filename, size_bytes, duration_seconds)
       VALUES ($1, $2, $3, $4)`,
      [meetingId, filename, sizeBytes, duration],
    );

    // Always re-run the authoritative batch scribe_v2 pass over the full audio.
    // The realtime stream is preview-only and not reliably diarized, so live
    // segments are never trusted as the final transcript.
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

    const transcript = await queryUserSchemaOne<{ id: string }>(
      session.user.id,
      `INSERT INTO transcripts (meeting_id, raw_text, segments, pii_removed_at, pii_replacements)
       VALUES ($1, $2, $3, NULL, $4)
       RETURNING id`,
      [meetingId, rawText, JSON.stringify(rawSegments), JSON.stringify(replacements)],
    );

    await queryUserSchemaOne(
      session.user.id,
      `UPDATE meetings SET status = 'review', updated_at = NOW() WHERE id = $1`,
      [meetingId],
    );

    return NextResponse.json({
      transcriptId: transcript!.id,
      segments: rawSegments,
      piiReplacementCount: replacements.length,
    });
  } catch (err) {
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

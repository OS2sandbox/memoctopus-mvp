import { NextRequest, NextResponse, after } from 'next/server';
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

  // Update mode: a live transcript already exists (created by save-transcript).
  // Save audio + run PII on the live segments immediately (fast path so the review
  // page has something to show). Then re-transcribe the full audio in the background
  // and overwrite the live segments with the authoritative batch result — this fills
  // in any gaps the per-utterance live path missed due to latency spikes or timeouts.
  if (transcriptId) {
    let buffer: Buffer;
    try {
      buffer = Buffer.from(await audioFile.arrayBuffer());
    } catch (err) {
      return NextResponse.json({ error: 'Failed to read audio' }, { status: 400 });
    }

    const mimeType = audioFile.type || 'audio/webm';
    const duration = durationStr ? parseInt(durationStr, 10) : null;
    const userId = session.user.id;

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
        { error: err instanceof Error ? err.message : 'Upload failed' },
        { status: 500 },
      );
    }

    // Run PII on the live segments so the review page isn't waiting on the batch pass.
    const existing = await queryUserSchemaOne<{ segments: unknown }>(
      userId,
      'SELECT segments FROM transcripts WHERE id = $1',
      [transcriptId],
    );
    const liveSegments = Array.isArray(existing?.segments)
      ? (existing.segments as TranscriptSegment[])
      : [];

    let liveReplacements: PiiReplacement[] = [];
    try {
      const piiResult = await detectPiiInSegments(liveSegments);
      liveReplacements = piiResult.replacements;
    } catch (piiErr) {
      console.error('PII detection failed (non-fatal):', piiErr);
    }

    await queryUserSchemaOne(
      userId,
      'UPDATE transcripts SET pii_replacements = $1 WHERE id = $2',
      [JSON.stringify(liveReplacements), transcriptId],
    );

    // Re-transcribe the full audio in the background. The batch pass processes the
    // complete recording and fills gaps the per-utterance live path missed.
    // We flip status to 'processing' so the review page's 4 s poll picks up the
    // update when it completes; a short delay lets the user see the live preview first.
    after(async () => {
      await new Promise((r) => setTimeout(r, 3_000));
      await queryUserSchemaOne(
        userId,
        `UPDATE meetings SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [meetingId],
      ).catch(() => {});

      try {
        console.log(`[transcribe] starting batch re-transcription for meeting ${meetingId}`);
        const provider = getTranscriptionProvider();
        const rawSegments: TranscriptSegment[] = await provider.transcribe(buffer, mimeType, duration ?? undefined);

        let replacements: PiiReplacement[] = [];
        try {
          const piiResult = await detectPiiInSegments(rawSegments);
          replacements = piiResult.replacements;
        } catch (piiErr) {
          console.error('PII detection failed in batch re-transcription (non-fatal):', piiErr);
        }
        const rawText = rawSegments.map((s) => s.text).join(' ');

        await queryUserSchemaOne(
          userId,
          `INSERT INTO transcripts (meeting_id, raw_text, segments, pii_removed_at, pii_replacements)
           VALUES ($1, $2, $3, NULL, $4)
           ON CONFLICT (meeting_id) DO UPDATE SET
             raw_text = EXCLUDED.raw_text,
             segments = EXCLUDED.segments,
             pii_replacements = EXCLUDED.pii_replacements`,
          [meetingId, rawText, JSON.stringify(rawSegments), JSON.stringify(replacements)],
        );
        console.log(`[transcribe] batch re-transcription complete for meeting ${meetingId}: ${rawSegments.length} segments`);
      } catch (err) {
        console.error(`[transcribe] batch re-transcription failed for meeting ${meetingId}:`, err);
      } finally {
        await queryUserSchemaOne(
          userId,
          `UPDATE meetings SET status = 'review', updated_at = NOW() WHERE id = $1`,
          [meetingId],
        ).catch(() => {});
      }
    });

    return NextResponse.json({ piiReplacements: liveReplacements });
  }

  // Create mode: save audio. When storageOnly=true the client handles transcription itself
  // via VAD batch uploads and calls save-transcript directly — skip the background job.
  const storageOnly = formData.get('storageOnly') === 'true';

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await audioFile.arrayBuffer());
  } catch (err) {
    return NextResponse.json({ error: 'Failed to read audio' }, { status: 400 });
  }

  const mimeType = audioFile.type || 'audio/webm';
  const duration = durationStr ? parseInt(durationStr, 10) : null;
  const userId = session.user.id;

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
    return NextResponse.json({ error: 'Failed to save audio' }, { status: 500 });
  }

  // storageOnly: audio archived, client handles transcription — don't touch status.
  if (storageOnly) return NextResponse.json({ ok: true });

  await queryUserSchemaOne(
    userId,
    `UPDATE meetings SET status = 'processing', updated_at = NOW() WHERE id = $1`,
    [meetingId],
  );

  // Run the STT + PII pipeline after the response so the client isn't blocked.
  // The review page polls every 4 s and will pick up the status change to 'review'.
  after(async () => {
    try {
      const provider = getTranscriptionProvider();
      // Pass the actual recording duration so timestamps reflect real wall-clock time,
      // not a bitrate estimate (Chrome records at ~200 kbps, not the assumed 64 kbps).
      const rawSegments: TranscriptSegment[] = await provider.transcribe(buffer, mimeType, duration ?? undefined);

      let replacements: PiiReplacement[] = [];
      try {
        const piiResult = await detectPiiInSegments(rawSegments);
        replacements = piiResult.replacements;
      } catch (piiErr) {
        console.error('PII detection failed (non-fatal):', piiErr);
      }
      const rawText = rawSegments.map((s) => s.text).join(' ');

      await queryUserSchemaOne<{ id: string }>(
        userId,
        `INSERT INTO transcripts (meeting_id, raw_text, segments, pii_removed_at, pii_replacements)
         VALUES ($1, $2, $3, NULL, $4)
         ON CONFLICT (meeting_id) DO UPDATE SET
           raw_text = EXCLUDED.raw_text,
           segments = EXCLUDED.segments,
           pii_replacements = EXCLUDED.pii_replacements
         RETURNING id`,
        [meetingId, rawText, JSON.stringify(rawSegments), JSON.stringify(replacements)],
      );

      await queryUserSchemaOne(
        userId,
        `UPDATE meetings SET status = 'review', updated_at = NOW() WHERE id = $1`,
        [meetingId],
      );
    } catch (err) {
      console.error('Background transcription error:', err);
      await queryUserSchemaOne(
        userId,
        `UPDATE meetings SET status = 'failed', updated_at = NOW() WHERE id = $1`,
        [meetingId],
      ).catch(() => {});
    }
  });

  return NextResponse.json({ ok: true });
}

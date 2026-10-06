import { NextRequest, NextResponse } from 'next/server';
import { getTranscriptionProvider } from '@/lib/ai/transcription';
import { detectPiiInSegments } from '@/lib/ai/pii';
import { groupIntoChapters } from '@/lib/ai/chapters';
import { TranscriptSegment, PiiReplacement } from '@/types';
import type { TranscriptChapter } from '@/lib/ai/chapters';
import { withHandler } from '@/lib/api-handler';
import { safeLogError } from '@/lib/audit/safe-log';
import { requireAppAccess } from '@/lib/authz/app-access';

export const maxDuration = 300;

function parseDuration(raw: string | null): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : Math.max(0, Math.min(7_200, n));
}

async function postHandler(req: NextRequest) {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;

  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  const meetingId = formData.get('meetingId') as string | null;
  const duration = parseDuration(formData.get('duration') as string | null);

  if (!audioFile || !meetingId) {
    return NextResponse.json({ error: 'Missing audio file or meetingId' }, { status: 400 });
  }

  const buffer = Buffer.from(await audioFile.arrayBuffer());
  const mimeType = audioFile.type || 'audio/webm';

  let segments: TranscriptSegment[] = [];
  let piiReplacements: PiiReplacement[] = [];

  try {
    const provider = getTranscriptionProvider();
    // Pass the actual recording duration so timestamps reflect real wall-clock time,
    // not a bitrate estimate (Chrome records at ~200 kbps, not the assumed 64 kbps).
    segments = await provider.transcribe(buffer, mimeType, duration ?? undefined);
  } catch (err) {
    safeLogError('transcribe', err);
    return NextResponse.json({ error: 'Transcription failed' }, { status: 500 });
  }
  try {
    const piiResult = await detectPiiInSegments(segments);
    piiReplacements = piiResult.replacements;
  } catch (piiErr) {
    safeLogError('transcribe pii (non-fatal)', piiErr);
  }

  let chapters: TranscriptChapter[] = [];
  if (segments.length > 0) {
    try {
      chapters = await groupIntoChapters(segments);
    } catch (chapErr) {
      safeLogError('transcribe chapters (non-fatal)', chapErr);
    }
  }

  const rawText = segments.map((s) => s.text).join(' ');

  return NextResponse.json({ segments, piiReplacements, rawText, chapters });
}

export const POST = withHandler('transcribe', postHandler);

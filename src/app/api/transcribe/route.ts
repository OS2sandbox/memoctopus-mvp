import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getTranscriptionProvider } from '@/lib/ai/transcription';
import { detectPiiInSegments } from '@/lib/ai/pii';
import { groupIntoChapters } from '@/lib/ai/chapters';
import { TranscriptSegment, PiiReplacement } from '@/types';
import type { TranscriptChapter } from '@/lib/ai/chapters';

export const maxDuration = 300;

function parseDuration(raw: string | null): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : Math.max(0, Math.min(7_200, n));
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
    console.error('Transcription error:', err);
    return NextResponse.json({ error: 'Transcription failed' }, { status: 500 });
  }

  try {
    const piiResult = await detectPiiInSegments(segments);
    piiReplacements = piiResult.replacements;
  } catch (piiErr) {
    console.error('PII detection failed (non-fatal):', piiErr);
  }

  let chapters: TranscriptChapter[] = [];
  try {
    if (segments.length > 0) {
      chapters = await groupIntoChapters(segments);
    }
  } catch (chapErr) {
    console.error('Chapter generation failed (non-fatal):', chapErr);
  }

  const rawText = segments.map((s) => s.text).join(' ');

  return NextResponse.json({ segments, piiReplacements, rawText, chapters });
}

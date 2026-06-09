import { NextRequest, NextResponse } from 'next/server';
import { getTranscriptionProvider } from '@/lib/ai/transcription';
import { detectPiiInSegments } from '@/lib/ai/pii';
import { groupIntoChapters } from '@/lib/ai/chapters';
import { TranscriptSegment, PiiReplacement } from '@/types';
import type { TranscriptChapter } from '@/lib/ai/chapters';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  const meetingId = formData.get('meetingId') as string | null;

  if (!audioFile || !meetingId) {
    return NextResponse.json({ error: 'Missing audio file or meetingId' }, { status: 400 });
  }

  const buffer = Buffer.from(await audioFile.arrayBuffer());
  const mimeType = audioFile.type || 'audio/webm';

  let segments: TranscriptSegment[] = [];
  let piiReplacements: PiiReplacement[] = [];

  try {
    const provider = getTranscriptionProvider();
    segments = await provider.transcribe(buffer, mimeType);
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

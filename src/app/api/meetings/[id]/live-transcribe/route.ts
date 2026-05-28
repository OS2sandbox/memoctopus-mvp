import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getTranscriptionProvider } from '@/lib/ai/transcription';

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id: _id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  if (!audioFile) return NextResponse.json({ error: 'Missing audio' }, { status: 400 });

  const buffer = Buffer.from(await audioFile.arrayBuffer());

  // Ignore tiny chunks — not enough audio to transcribe meaningfully
  if (buffer.length < 10_000) return NextResponse.json({ segments: [], text: '' });

  try {
    const provider = getTranscriptionProvider();
    const segments = await provider.transcribe(buffer, audioFile.type || 'audio/webm');
    const text = segments.map((s) => s.text).join(' ');
    return NextResponse.json({ segments, text });
  } catch (err) {
    console.error('Live transcription error:', err);
    return NextResponse.json({ segments: [], text: '' });
  }
}

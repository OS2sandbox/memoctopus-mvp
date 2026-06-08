import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { HviskeProvider } from '@/lib/ai/transcription';

interface Params {
  params: Promise<{ id: string }>;
}

// Per-utterance transcription for the VAD-based live recording path.
// Always uses HviskeProvider directly — independent of TRANSCRIPTION_PROVIDER,
// which controls only the final batch pass. No DB write: the frontend accumulates
// live segments; the authoritative transcript is written by /api/transcribe at end.
export async function POST(req: NextRequest, { params }: Params) {
  const { id: _id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  if (!audioFile) return NextResponse.json({ error: 'Missing audio' }, { status: 400 });

  const buffer = Buffer.from(await audioFile.arrayBuffer());
  if (buffer.length < 2_000) return NextResponse.json({ text: '' });

  try {
    const provider = new HviskeProvider();
    const text = await provider.transcribeRaw(buffer, audioFile.type || 'audio/wav');
    return NextResponse.json({ text });
  } catch (err) {
    console.error('Utterance transcription error:', err);
    return NextResponse.json({ text: '' });
  }
}

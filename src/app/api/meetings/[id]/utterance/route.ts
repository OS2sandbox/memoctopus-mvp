import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { HviskeProvider } from '@/lib/ai/transcription';

interface Params {
  params: Promise<{ id: string }>;
}

// Whisper-based models hallucinate looping repetitions when given short or noisy
// audio. Detect this by checking if a single word dominates the output (>50% of
// all words) or if the same word appears 3+ times consecutively.
function isHallucinatedRepetition(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;

  const freq: Record<string, number> = {};
  for (const w of words) freq[w] = (freq[w] ?? 0) + 1;
  if (Math.max(...Object.values(freq)) / words.length > 0.5) return true;

  let streak = 1;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) {
      if (++streak >= 3) return true;
    } else {
      streak = 1;
    }
  }
  return false;
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

  const audioBytes = buffer.length;
  const t0 = Date.now();
  try {
    const provider = new HviskeProvider();
    const { text, latencyMs } = await provider.transcribeRaw(buffer, audioFile.type || 'audio/wav');
    const totalMs = Date.now() - t0;
    console.log(`[utterance] ${audioBytes} bytes → ${latencyMs} ms hviske / ${totalMs} ms total`);
    if (isHallucinatedRepetition(text)) return NextResponse.json({ text: '', latencyMs });
    return NextResponse.json({ text, latencyMs });
  } catch (err) {
    const totalMs = Date.now() - t0;
    console.error(`[utterance] failed after ${totalMs} ms:`, err);
    return NextResponse.json({ text: '', latencyMs: totalMs });
  }
}

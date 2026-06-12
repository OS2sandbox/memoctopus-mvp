import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getDiarizationProvider } from '@/lib/ai/diarization';

interface Params {
  params: Promise<{ id: string }>;
}

// Speaker diarization for the batch processing pass. Stateless compute: takes the
// full recording (one WAV of the whole meeting), runs the self-hosted pyannote
// service, and returns speaker turns. No persistence — the client merges the turns
// onto its transcript segments (see merge-speakers.ts) and stores the result in
// IndexedDB. Diarization must run over the WHOLE recording in one pass because
// speaker identity is global, so this is a single request, not per-utterance.
export async function POST(req: NextRequest, { params }: Params) {
  const { id: _id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  if (!audioFile) return NextResponse.json({ error: 'Missing audio' }, { status: 400 });

  const buffer = Buffer.from(await audioFile.arrayBuffer());
  if (buffer.length < 2_000) return NextResponse.json({ turns: [] });

  const t0 = Date.now();
  try {
    const turns = await getDiarizationProvider().diarize(buffer, audioFile.type || 'audio/wav');
    console.log(`[diarize] ${buffer.length} bytes → ${turns.length} turns in ${Date.now() - t0} ms`);
    return NextResponse.json({ turns });
  } catch (err) {
    // Non-fatal: the client falls back to single-speaker labels when turns is empty.
    console.error(`[diarize] failed after ${Date.now() - t0} ms:`, err);
    return NextResponse.json({ turns: [] });
  }
}

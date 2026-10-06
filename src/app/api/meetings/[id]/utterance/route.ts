import { NextRequest, NextResponse } from 'next/server';
import { HviskeProvider } from '@/lib/ai/transcription';
import { withHandler } from '@/lib/api-handler';
import { safeLogError } from '@/lib/audit/safe-log';
import { asEntityUuid, elapsedMs, emitAudit, outcomeCodeOf } from '@/app/api/meetings/ai-audit';
import { liveTranscriptionCoalescer, liveTranscriptionKey } from './coalesce';
import { requireAppAccess } from '@/lib/authz/app-access';

// Reuse a single provider instance across requests — creating one per request
// would spin up a new OpenAI client each time, losing connection pooling.
let _provider: HviskeProvider | null = null;
function getProvider(): HviskeProvider {
  if (!_provider) _provider = new HviskeProvider();
  return _provider;
}

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

// Per-utterance transcription for the VAD-based recording/upload path.
// Stateless compute: transcribes one audio batch via Hviske and returns the text.
// No persistence — the client accumulates segments and stores the transcript in
// IndexedDB (see RecordingScreen / upload-confirm / ProcessingTranscription).
async function postHandler(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  if (!audioFile) return NextResponse.json({ error: 'Missing audio' }, { status: 400 });

  const buffer = Buffer.from(await audioFile.arrayBuffer());
  if (buffer.length < 2_000) return NextResponse.json({ text: '' });

  const audioBytes = buffer.length;
  const userId = session.user.id;
  // The id in the URL is never verified against a meeting, so only a UUID becomes the audit
  // entity; any other id is still audited, without an entity and keyed on the actor alone.
  const entityId = asEntityUuid(id);
  // One request every few seconds per meeting would flood the log, so at most one
  // event per actor+meeting+outcome per hour is written (best-effort, per process);
  // it marks that live transcription happened, it is not a count of utterances.
  const audit = async (outcome: 'success' | 'error', t0: number, outcomeCode?: string) => {
    if (!liveTranscriptionCoalescer.shouldEmit(liveTranscriptionKey(userId, entityId, outcome))) return;
    await emitAudit(req, {
      type: 'transcription.request',
      actorUserId: userId,
      outcome,
      entityId,
      details: { mode: 'live', durationMs: elapsedMs(t0), ...(outcomeCode ? { outcomeCode } : {}) },
    });
  };

  const t0 = Date.now();
  try {
    const { text, latencyMs } = await getProvider().transcribeRaw(buffer, audioFile.type || 'audio/wav');
    const totalMs = Date.now() - t0;
    console.log(`[utterance] ${audioBytes} bytes → ${latencyMs} ms hviske / ${totalMs} ms total`);
    await audit('success', t0);
    if (isHallucinatedRepetition(text)) return NextResponse.json({ text: '', latencyMs });
    return NextResponse.json({ text, latencyMs });
  } catch (err) {
    const totalMs = Date.now() - t0;
    safeLogError(`utterance failed after ${totalMs} ms`, err);
    await audit('error', t0, outcomeCodeOf(err));
    // 502, not 200-with-empty-text: callers must be able to tell "silence" from
    // "transcription failed" so failed batches are retried instead of silently
    // dropping ~27 s of audio from the transcript.
    return NextResponse.json({ error: 'Transcription failed', latencyMs: totalMs }, { status: 502 });
  }
}

export const POST = withHandler('utterance', postHandler);

import { NextRequest, NextResponse } from 'next/server';
import { getDiarizationProvider } from '@/lib/ai/diarization';
import { withHandler } from '@/lib/api-handler';
import { safeLogError } from '@/lib/audit/safe-log';
import { asEntityUuid, elapsedMs, emitAudit, outcomeCodeOf } from '@/app/api/meetings/ai-audit';
import { requireAppAccess } from '@/lib/authz/app-access';

interface Params {
  params: Promise<{ id: string }>;
}

// Speaker diarization for the batch processing pass. Stateless compute: takes the
// full recording (one WAV of the whole meeting), runs the self-hosted pyannote
// service, and returns speaker turns. No persistence — the client merges the turns
// onto its transcript segments (see merge-speakers.ts) and stores the result in
// IndexedDB. Diarization must run over the WHOLE recording in one pass because
// speaker identity is global, so this is a single request, not per-utterance.
async function postHandler(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  if (!audioFile) return NextResponse.json({ error: 'Missing audio' }, { status: 400 });

  const buffer = Buffer.from(await audioFile.arrayBuffer());
  if (buffer.length < 2_000) return NextResponse.json({ turns: [] });

  // The id in the URL is never verified against a meeting: UUID or no entity.
  const entityId = asEntityUuid(id);
  const t0 = Date.now();
  try {
    const turns = await getDiarizationProvider().diarize(buffer, audioFile.type || 'audio/wav');
    console.log(`[diarize] ${buffer.length} bytes → ${turns.length} turns in ${Date.now() - t0} ms`);
    await emitAudit(req, {
      type: 'diarization.request',
      actorUserId: session.user.id,
      entityId,
      details: { speakerCount: new Set(turns.map((t) => t.speaker)).size, durationMs: elapsedMs(t0) },
    });
    return NextResponse.json({ turns });
  } catch (err) {
    // Non-fatal: the client falls back to single-speaker labels when turns is empty.
    safeLogError(`diarize failed after ${Date.now() - t0} ms`, err);
    await emitAudit(req, {
      type: 'diarization.request',
      actorUserId: session.user.id,
      outcome: 'error',
      entityId,
      details: { durationMs: elapsedMs(t0), outcomeCode: outcomeCodeOf(err) },
    });
    return NextResponse.json({ turns: [] });
  }
}

export const POST = withHandler('diarize', postHandler);

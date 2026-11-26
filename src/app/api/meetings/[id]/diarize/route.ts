import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getDiarizationProvider } from '@/lib/ai/diarization';
import { DIARIZE_PING_INTERVAL_MS } from '@/lib/audio/diarize-stream';

interface Params {
  params: Promise<{ id: string }>;
}

// Diarizing a long meeting takes tens of minutes on CPU, during which a plain
// JSON response would carry zero bytes — and any middlebox between the browser
// and this route (VPN, firewall, proxy) may silently drop the idle connection
// long before DIARIZATION_TIMEOUT_MS. Observed in production: the service
// finished a 48-minute job twice while the browser had been cut off at ~5-10
// minutes each time. The response is therefore an NDJSON stream that emits a
// ping while waiting, so bytes keep flowing end to end — the same reason the
// transcribe-batches route streams.
type DiarizeEvent =
  | { type: 'ping' }
  | { type: 'done'; turns: unknown[] }
  | { type: 'error' };

function ndjsonLine(event: DiarizeEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event) + '\n');
}

function ndjsonResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

function singleEventStream(event: DiarizeEvent): Response {
  return ndjsonResponse(new ReadableStream({
    start(controller) {
      controller.enqueue(ndjsonLine(event));
      controller.close();
    },
  }));
}

// Speaker diarization for the batch processing pass. Stateless compute: takes the
// full recording (the original compressed file of the whole meeting), runs the
// self-hosted pyannote service, and streams back the speaker turns. No persistence —
// the client merges the turns onto its transcript segments (see merge-speakers.ts)
// and stores the result in IndexedDB. Diarization must run over the WHOLE recording
// in one pass because speaker identity is global, so this is a single request, not
// per-utterance. The time limit is DIARIZATION_TIMEOUT_MS, enforced by the provider
// against the diarization service.
export async function POST(req: NextRequest, { params }: Params) {
  const { id: _id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const formData = await req.formData();
  const audioFile = formData.get('audio') as File | null;
  if (!audioFile) return NextResponse.json({ error: 'Missing audio' }, { status: 400 });

  const buffer = Buffer.from(await audioFile.arrayBuffer());
  if (buffer.length < 2_000) return singleEventStream({ type: 'done', turns: [] });

  const t0 = Date.now();
  return ndjsonResponse(new ReadableStream({
    async start(controller) {
      // Enqueueing after the browser disconnected throws — swallow it, the result
      // is simply undeliverable (and logged below either way).
      const send = (event: DiarizeEvent) => {
        try { controller.enqueue(ndjsonLine(event)); } catch { /* client gone */ }
      };
      const ping = setInterval(() => send({ type: 'ping' }), DIARIZE_PING_INTERVAL_MS);
      try {
        const turns = await getDiarizationProvider().diarize(buffer, audioFile.type || 'audio/wav');
        console.log(`[diarize] ${buffer.length} bytes → ${turns.length} turns in ${Date.now() - t0} ms`);
        send({ type: 'done', turns });
      } catch (err) {
        // Non-fatal: the client falls back to manual speaker assignment.
        console.error(`[diarize] failed after ${Date.now() - t0} ms:`, err);
        send({ type: 'error' });
      } finally {
        clearInterval(ping);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  }));
}

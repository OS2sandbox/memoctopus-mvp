import { z } from 'zod';
import type { TranscriptSegment } from '@/types';
import { splitTextWithIntervals, type VadInterval } from '@/lib/audio/vad-batch';
import { connectivity } from './connectivity';

// A 27 s batch takes hviske a few seconds; a minute without an answer is a stalled
// connection, and the queue will try again.
const REQUEST_TIMEOUT_MS = 60_000;

const UtteranceReply = z.object({ text: z.string() });

/**
 * Sends one sealed batch to `POST /api/meetings/[id]/utterance` and places the text
 * on the meeting's timeline. `retry` covers everything worth trying again (no
 * network, timeout, a server or proxy error); `auth` means the session has expired
 * and retrying before the user signs in again is pointless.
 */
export async function transcribeBatch(
  meetingId: string,
  batch: { wav: ArrayBuffer; intervals: VadInterval[]; totalWavDuration: number },
): Promise<{ kind: 'text'; segments: TranscriptSegment[] } | { kind: 'retry' } | { kind: 'auth' }> {
  const body = new FormData();
  body.append('audio', new Blob([batch.wav], { type: 'audio/wav' }), 'batch.wav');
  let res: Response;
  try {
    res = await fetch(`/api/meetings/${meetingId}/utterance`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    connectivity.reportNetworkFailure();
    return { kind: 'retry' };
  }
  connectivity.reportSuccess();

  if (res.status === 401) return { kind: 'auth' };
  if (!res.ok) return { kind: 'retry' };
  const reply = UtteranceReply.safeParse(await res.json().catch(() => null));
  if (!reply.success) return { kind: 'retry' };
  return { kind: 'text', segments: splitTextWithIntervals(reply.data.text, batch.intervals, batch.totalWavDuration) };
}

import type { TranscriptSegment } from '@/types';

// Client for POST /api/meetings/[id]/transcribe-batches: uploads the original
// compressed recording once and consumes the NDJSON progress stream. The heavy
// work (ffmpeg decode, VAD, simultaneous hviske fan-out) happens server-side —
// the browser neither decodes the audio nor pays its ~6-connection fan-out cap.

export interface TranscribeMeta {
  totalBatches: number;
  totalSpeechSeconds: number;
}

export interface TranscribeBatchUpdate {
  segments: TranscriptSegment[];
  batchSeconds: number;
  completedBatches: number;
  totalBatches: number;
}

export interface TranscribeResult {
  segments: TranscriptSegment[];
  totalSpeechSeconds: number;
  totalBatches: number;
  failedSeconds: number;
  // True when the segments already carry real speaker labels (the server diarized
  // inline via the ensemble endpoint), so the caller can skip the separate
  // diarization pass. Absent/false for the legacy VAD path.
  diarized: boolean;
}

type StreamEvent =
  | ({ type: 'meta' } & TranscribeMeta)
  | ({ type: 'batch' } & TranscribeBatchUpdate)
  | { type: 'done'; segments: TranscriptSegment[]; failedSeconds: number; diarized?: boolean }
  | { type: 'error'; message: string };

export async function transcribeBatchesOnServer(
  meetingId: string,
  audio: Blob,
  handlers?: {
    onMeta?: (meta: TranscribeMeta) => void;
    onBatch?: (update: TranscribeBatchUpdate) => void;
  },
): Promise<TranscribeResult> {
  const fd = new FormData();
  fd.append('audio', audio, 'recording');

  const res = await fetch(`/api/meetings/${meetingId}/transcribe-batches`, {
    method: 'POST',
    body: fd,
    // Generous: covers the upload plus server-side decode + fan-out for very
    // long recordings. Individual batches have their own server-side timeouts.
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Transskriptionsserveren svarede ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let meta: TranscribeMeta = { totalBatches: 0, totalSpeechSeconds: 0 };
  let final: { segments: TranscriptSegment[]; failedSeconds: number; diarized: boolean } | null = null;

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as StreamEvent;
    switch (event.type) {
      case 'meta':
        meta = { totalBatches: event.totalBatches, totalSpeechSeconds: event.totalSpeechSeconds };
        handlers?.onMeta?.(meta);
        break;
      case 'batch':
        handlers?.onBatch?.(event);
        break;
      case 'done':
        final = { segments: event.segments, failedSeconds: event.failedSeconds, diarized: event.diarized ?? false };
        break;
      case 'error':
        throw new Error(event.message);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      handleLine(line);
    }
  }
  handleLine(buffered);

  if (!final) throw new Error('Transskriptionen blev afbrudt før den var færdig');
  const done = final as { segments: TranscriptSegment[]; failedSeconds: number; diarized: boolean };
  return { segments: done.segments, failedSeconds: done.failedSeconds, diarized: done.diarized, ...meta };
}

import { transcribeWithVadBatches, transcribeEnsemble, isEnsembleDiarization } from '@/lib/audio/vad-batch-server';
import { getDiarizationProvider } from '@/lib/ai/diarization';
import { assignSpeakers } from '@/lib/audio/merge-speakers';
import { storePendingTranscript } from '@/lib/pending-artifacts';

// Server-side transcription of a Teams recording (see teams/pipeline.ts, where it
// is the recording-only mode): hviske transcribes while diarization runs in
// parallel, and the merged transcript goes into the pending stash the browser
// collects. Fail-soft: a failure marks the stash 'failed' instead of throwing,
// and the caller reads that verdict back.
export async function transcribeRecording(
  meetingId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<void> {
  const t0 = Date.now();

  try {
    // Ensemble path: one call returns diarized, timestamped segments — no separate
    // diarization pass to merge.
    if (isEnsembleDiarization()) {
      const segments = await transcribeEnsemble(buffer, mimeType);
      await storePendingTranscript(meetingId, { status: 'ready', segments, diarized: true });
      console.log(`[transcribe-recording] ${meetingId}: ${segments.length} ensemble segments in ${Date.now() - t0} ms`);
      return;
    }

    const [transcription, diarization] = await Promise.allSettled([
      transcribeWithVadBatches(buffer),
      getDiarizationProvider().diarize(buffer, mimeType),
    ]);

    if (transcription.status === 'rejected') {
      console.error(`[transcribe-recording] ${meetingId} transcription failed:`, transcription.reason);
      await storePendingTranscript(meetingId, { status: 'failed' });
      return;
    }

    const turns = diarization.status === 'fulfilled' ? diarization.value : [];
    if (diarization.status === 'rejected') {
      // Non-fatal: ship the transcript with default labels.
      console.error(`[transcribe-recording] ${meetingId} diarization failed:`, diarization.reason);
    }

    const segments = assignSpeakers(transcription.value, turns);
    await storePendingTranscript(meetingId, {
      status: 'ready',
      segments,
      diarized: turns.length > 0,
    });
    console.log(
      `[transcribe-recording] ${meetingId}: ${segments.length} segments ` +
      `(diarized=${turns.length > 0}) in ${Date.now() - t0} ms`,
    );
  } catch (err) {
    console.error(`[transcribe-recording] ${meetingId} failed:`, err);
    await storePendingTranscript(meetingId, { status: 'failed' }).catch(() => {});
  }
}

import { transcribeWithVadBatches, transcribeEnsemble, isEnsembleDiarization } from '@/lib/audio/vad-batch-server';
import { getDiarizationProvider, type SpeakerTurn } from '@/lib/ai/diarization';
import { assignSpeakers } from '@/lib/audio/merge-speakers';
import { storePendingTranscript } from '@/lib/pending-artifacts';

export interface TranscribeRecordingOptions {
  /**
   * Speaker timeline to merge in instead of running diarization. Teams meetings
   * supply this from the meeting's own VTT transcript, where the turns already
   * carry human display names — no pyannote pass needed, and no `Taler N`.
   */
  turns?: SpeakerTurn[];
  /** Keep the turn labels verbatim (real names) rather than remapping to `Taler N`. */
  preserveNames?: boolean;
}

// Server-side processing of a Teams recording, kicked off the moment the audio
// lands — NOT when the user's browser eventually polls the audio down. The server
// already holds the audio, so the old stash → poll → download → browser-decode →
// re-upload chain is pure dead time on the critical path.
//
// Transcription (ffmpeg decode + VAD + simultaneous hviske fan-out) and diarization
// run in parallel; the merged transcript is stashed next to the pending audio for
// the client to collect into IndexedDB. Everything is fail-soft: on failure the
// stash is marked 'failed' and the client falls back to driving transcription
// itself via /api/meetings/[id]/transcribe-batches.
//
// When `opts.turns` is supplied the diarization pass is skipped entirely: the
// caller already knows who spoke when (Graph pipeline → VTT).
export async function transcribeRecording(
  meetingId: string,
  buffer: Buffer,
  mimeType: string,
  opts: TranscribeRecordingOptions = {},
): Promise<void> {
  const t0 = Date.now();
  const injectedTurns = opts.turns;
  const mergeOptions = { preserveNames: opts.preserveNames === true };

  try {
    // Ensemble path: one call returns diarized, timestamped segments — no separate
    // diarization pass to merge. Injected turns still win, because they carry names.
    if (isEnsembleDiarization()) {
      const ensembleSegments = await transcribeEnsemble(buffer, mimeType);
      const segments = injectedTurns?.length
        ? assignSpeakers(ensembleSegments, injectedTurns, mergeOptions)
        : ensembleSegments;
      await storePendingTranscript(meetingId, { status: 'ready', segments, diarized: true });
      console.log(`[transcribe-recording] ${meetingId}: ${segments.length} ensemble segments in ${Date.now() - t0} ms`);
      return;
    }

    if (injectedTurns) {
      // Turns are known up front — transcribe only.
      let transcribed;
      try {
        transcribed = await transcribeWithVadBatches(buffer);
      } catch (err) {
        console.error(`[transcribe-recording] ${meetingId} transcription failed:`, err);
        await storePendingTranscript(meetingId, { status: 'failed' });
        return;
      }
      const segments = assignSpeakers(transcribed, injectedTurns, mergeOptions);
      await storePendingTranscript(meetingId, {
        status: 'ready',
        segments,
        diarized: injectedTurns.length > 0,
      });
      console.log(
        `[transcribe-recording] ${meetingId}: ${segments.length} segments ` +
        `(injected turns=${injectedTurns.length}) in ${Date.now() - t0} ms`,
      );
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
      // Non-fatal: ship the transcript with default labels; the client can diarize.
      console.error(`[transcribe-recording] ${meetingId} diarization failed:`, diarization.reason);
    }

    const segments = assignSpeakers(transcription.value, turns, mergeOptions);
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

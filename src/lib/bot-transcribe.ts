import { transcribeWithVadBatches } from '@/lib/audio/vad-batch-server';
import { getDiarizationProvider } from '@/lib/ai/diarization';
import { assignSpeakers } from '@/lib/audio/merge-speakers';
import { storePendingTranscript } from '@/lib/bot-pending-audio';

// Server-side processing of a Teams-bot recording, kicked off the moment the bot
// uploads — NOT when the user's browser eventually polls the audio down. The server
// already holds the audio, so the old stash → poll → download → browser-decode →
// re-upload chain is pure dead time on the critical path.
//
// Transcription (ffmpeg decode + VAD + simultaneous hviske fan-out) and diarization
// run in parallel; the merged transcript is stashed next to the pending audio for
// the client to collect into IndexedDB. Everything is fail-soft: on failure the
// stash is marked 'failed' and the client falls back to driving transcription
// itself via /api/meetings/[id]/transcribe-batches.
export async function processBotRecording(
  meetingId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<void> {
  const t0 = Date.now();
  try {
    const [transcription, diarization] = await Promise.allSettled([
      transcribeWithVadBatches(buffer),
      getDiarizationProvider().diarize(buffer, mimeType),
    ]);

    if (transcription.status === 'rejected') {
      console.error(`[bot-transcribe] ${meetingId} transcription failed:`, transcription.reason);
      await storePendingTranscript(meetingId, { status: 'failed' });
      return;
    }

    const turns = diarization.status === 'fulfilled' ? diarization.value : [];
    if (diarization.status === 'rejected') {
      // Non-fatal: ship the transcript with default labels; the client can diarize.
      console.error(`[bot-transcribe] ${meetingId} diarization failed:`, diarization.reason);
    }

    const segments = assignSpeakers(transcription.value, turns);
    await storePendingTranscript(meetingId, {
      status: 'ready',
      segments,
      diarized: turns.length > 0,
    });
    console.log(
      `[bot-transcribe] ${meetingId}: ${segments.length} segments ` +
      `(diarized=${turns.length > 0}) in ${Date.now() - t0} ms`,
    );
  } catch (err) {
    console.error(`[bot-transcribe] ${meetingId} failed:`, err);
    await storePendingTranscript(meetingId, { status: 'failed' }).catch(() => {});
  }
}

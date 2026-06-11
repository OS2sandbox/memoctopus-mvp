import type { SpeakerTurn } from '@/lib/ai/diarization';
import { float32ToWavBlob } from './vad-batch';
import { decodeAndResampleTo16k } from './vad-client';

// Client-side helpers for the speaker-diarization pass. Diarization runs once over
// the WHOLE recording (speaker identity is global) and the returned turns are merged
// onto the transcript segments by time-overlap (see assignSpeakers in merge-speakers).
// Every helper is fail-soft: on any error it returns [] so the caller keeps the
// default single-speaker labels instead of breaking the recording flow.

// POST a full-recording WAV to the diarize route and return the speaker turns.
export async function fetchDiarizationTurns(meetingId: string, wav: Blob): Promise<SpeakerTurn[]> {
  try {
    const fd = new FormData();
    fd.append('audio', wav, 'recording.wav');
    const res = await fetch(`/api/meetings/${meetingId}/diarize`, {
      method: 'POST',
      body: fd,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) return [];
    const { turns } = await res.json() as { turns: SpeakerTurn[] };
    return Array.isArray(turns) ? turns : [];
  } catch (err) {
    console.error('[diarize] request failed:', err);
    return [];
  }
}

// For paths that already hold the decoded 16 kHz mono audio (upload, processing).
export function diarizeFromMono16k(meetingId: string, mono16k: Float32Array): Promise<SpeakerTurn[]> {
  return fetchDiarizationTurns(meetingId, float32ToWavBlob(mono16k));
}

// For paths that only hold the original recording blob (live mic). Decodes it to
// 16 kHz mono first — the same full-timeline basis the segment timestamps use.
export async function diarizeFromBlob(meetingId: string, blob: Blob): Promise<SpeakerTurn[]> {
  try {
    const mono16k = await decodeAndResampleTo16k(await blob.arrayBuffer());
    return diarizeFromMono16k(meetingId, mono16k);
  } catch (err) {
    console.error('[diarize] decode failed:', err);
    return [];
  }
}

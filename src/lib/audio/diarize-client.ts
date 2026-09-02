import type { SpeakerTurn } from '@/lib/ai/diarization';
import { assignSpeakers } from './merge-speakers';
import { DEFAULT_SPEAKER_LABEL } from './speaker-labels';
import { getTranscript, saveTranscriptSegments } from '@/lib/storage';
import { notifyTranscriptUpdated } from '@/lib/transcript-events';

// Client-side helpers for the speaker-diarization pass. Diarization runs once over
// the WHOLE recording (speaker identity is global) and the returned turns are merged
// onto the transcript segments by time-overlap (see assignSpeakers in merge-speakers).
// Every helper is fail-soft: on any error it returns [] so the caller keeps the
// default single-speaker labels instead of breaking the recording flow.

function getDiarizationTimeoutMs(): number {
  const value = Number(process.env.NEXT_PUBLIC_DIARIZATION_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 300_000;
}

// POST the recording to the diarize route and return the speaker turns. The blob is
// sent in its ORIGINAL compressed format (webm/opus, mp3, m4a, …) — the diarization
// service decodes it with ffmpeg. Shipping the compressed file instead of a decoded
// 16-bit PCM WAV cuts the payload ~4-10x (a 100-min meeting is ~190 MB as WAV) and
// skips the in-browser full-file decode that used to gate this request.
// Returns the speaker turns, or `null` when the diarization service could not be
// reached / errored. `null` is distinct from `[]` (ran but found no turns): the
// caller marks the transcript 'failed' on null so the review UI can tell the user
// automatic speaker recognition is unavailable rather than silently showing one
// speaker as if diarization had succeeded.
export async function fetchDiarizationTurns(meetingId: string, audio: Blob): Promise<SpeakerTurn[] | null> {
  try {
    const fd = new FormData();
    fd.append('audio', audio, 'recording');
    const res = await fetch(`/api/meetings/${meetingId}/diarize`, {
      method: 'POST',
      body: fd,
      signal: AbortSignal.timeout(getDiarizationTimeoutMs()),
    });
    if (!res.ok) {
      console.error('[diarize] non-OK response:', res.status);
      return null;
    }
    const { turns } = await res.json() as { turns: SpeakerTurn[] };
    return Array.isArray(turns) ? turns : [];
  } catch (err) {
    console.error('[diarize] request failed:', err);
    return null;
  }
}

// Meetings whose diarization request is currently in flight in this session. Lets
// the review screen tell "someone is already diarizing this" from "the page was
// reloaded mid-pass and nobody is" — so it only re-triggers in the latter case.
const diarizationInFlight = new Set<string>();

export function isDiarizationInFlight(meetingId: string): boolean {
  return diarizationInFlight.has(meetingId);
}

// Start the diarization request and register it as in-flight. Callers save the
// transcript with diarizationStatus:'pending' and later hand the resolved turns to
// finishDiarization. Kept separate from finishDiarization so the request can run in
// parallel with transcription and only be applied once the transcript is saved.
export function startDiarization(meetingId: string, audio: Blob): Promise<SpeakerTurn[] | null> {
  diarizationInFlight.add(meetingId);
  return fetchDiarizationTurns(meetingId, audio);
}

// Resolve the diarization for a saved transcript: merge speaker labels if we got
// any (and the user hasn't already relabelled — never clobber manual edits), then
// ALWAYS clear the 'pending' status to 'done' so the review UI leaves the
// uncertainty state even when diarization found nothing or failed. Notifies the
// review screen and clears the in-flight marker. Re-reads current segments rather
// than trusting a stale copy.
export async function finishDiarization(meetingId: string, turns: SpeakerTurn[] | null): Promise<void> {
  // `null` means the diarization service couldn't be reached — mark 'failed' so the
  // review UI surfaces it; `[]` means it ran but found no turns (treated as 'done').
  const failed = turns === null;
  try {
    const current = await getTranscript(meetingId);
    // No transcript saved yet — nothing to label or clear. The `finally` below
    // still drops the in-flight marker so a later retrigger isn't blocked.
    if (!current) return;
    // A transcript exists but has no segments (silent recording / failed STT).
    // There is nothing to label, but we MUST still flip 'pending' → terminal or the
    // review screen's diarization spinner hangs forever (and the safety-net
    // retrigger would loop on the same empty transcript).
    if (!current.segments?.length) {
      if (current.diarizationStatus === 'pending') {
        await saveTranscriptSegments(meetingId, current.segments ?? [], failed ? 'failed' : 'done');
        notifyTranscriptUpdated(meetingId);
      }
      return;
    }
    if (turns === null) {
      // Service unreachable: keep the existing (default) labels but record the
      // failure so the assignment UI can explain that recognition is unavailable.
      await saveTranscriptSegments(meetingId, current.segments, 'failed');
      notifyTranscriptUpdated(meetingId);
      return;
    }
    const segments = (turns.length > 0 && current.segments.every((s) => s.speaker === DEFAULT_SPEAKER_LABEL))
      ? assignSpeakers(current.segments, turns)
      : current.segments;
    await saveTranscriptSegments(meetingId, segments, 'done');
    notifyTranscriptUpdated(meetingId);
  } catch (err) {
    console.error('[diarize] finish failed:', err);
    // Best-effort: clear the 'pending' diarization status so the review UI's
    // "Genkender taler…" spinner doesn't hang forever after an unexpected throw.
    // Fetch current segments rather than assuming they're available from before the throw.
    try {
      const current = await getTranscript(meetingId);
      if (current && current.diarizationStatus === 'pending') {
        await saveTranscriptSegments(meetingId, current.segments ?? [], 'done');
        notifyTranscriptUpdated(meetingId);
      }
    } catch (innerErr) {
      console.error('[diarize] failed to clear pending status after error — UI may be stuck:', innerErr);
    }
  } finally {
    diarizationInFlight.delete(meetingId);
  }
}

// Convenience for callers that start and finish in one place.
export async function diarizeAndApply(meetingId: string, audio: Blob): Promise<void> {
  await finishDiarization(meetingId, await startDiarization(meetingId, audio));
}

// Safety net for the review screen: if a transcript is still 'pending' but no
// diarization is running in this session (e.g. the tab was reloaded mid-pass, so
// the original background request died), run it again from the stored audio so the
// labels don't hang in the uncertainty state forever. No-op if one is already running.
export async function ensureDiarization(meetingId: string, audio: Blob): Promise<void> {
  if (diarizationInFlight.has(meetingId)) return;
  await diarizeAndApply(meetingId, audio);
}

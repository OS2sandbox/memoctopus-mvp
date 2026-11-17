import type { TranscriptSegment } from '@/types';
import { graphDate } from './graph-dates';
import type { ArtifactRef } from './artifacts';
import type { VttCue } from './vtt';

// Putting several Teams artifacts of one meeting on one clock.
//
// A meeting whose recording was stopped and started again, or whose
// transcription was, has several recordings and transcripts in Graph. Each
// carries its own wall-clock span (createdDateTime → endDateTime), and inside
// each the times are relative to its own start. Everything here converts
// between the two, so the pipeline can transcribe every recording with the
// Teams cues that fall inside it and lay the results end to end.

/**
 * A transcript and a recording started within this of each other were started
 * together ("Start optagelse" starts both), and their own clocks are taken to
 * be the same. Graph's two timestamps differ by a second or two even then, and
 * shifting the cues by that noise would only misplace the cue slices.
 */
export const SAME_START_TOLERANCE_MS = 30 * 1000;

/** When an artifact began and ended, in epoch ms; null where Graph did not say. */
export interface ArtifactSpan {
  start: number | null;
  end: number | null;
}

/**
 * The span Graph reports for an artifact. `createdDateTime` is when recording
 * or transcription started and `endDateTime` when it stopped; a start after the
 * end cannot be a start, so it is dropped rather than trusted.
 */
export function artifactSpan(ref: Pick<ArtifactRef, 'createdDateTime' | 'endDateTime'>): ArtifactSpan {
  const created = graphDate(ref.createdDateTime);
  const ended = graphDate(ref.endDateTime);
  let start = created ? Date.parse(created) : null;
  const end = ended ? Date.parse(ended) : null;
  if (start != null && end != null && start > end) start = null;
  return { start, end };
}

/**
 * Where an artifact starts, given how long its content runs: the reported start,
 * or failing that the reported end minus the content.
 */
export function startOf(span: ArtifactSpan, durationSeconds: number | null): number | null {
  if (span.start != null) return span.start;
  if (span.end != null && durationSeconds != null) return span.end - durationSeconds * 1000;
  return null;
}

/** A transcript placed on the meeting's clock. */
export interface PlacedTranscript {
  start: number;
  cues: VttCue[];
  /** Per cue: already given to a recording, so it is not used twice. */
  used: boolean[];
}

export function placeTranscript(start: number, cues: VttCue[]): PlacedTranscript {
  return { start, cues, used: cues.map(() => false) };
}

/**
 * The cues that fall inside one recording, on the recording's own clock, taken
 * out of the pool so no other recording gets them too. A cue belongs to the
 * recording its midpoint falls in.
 */
export function takeCuesFor(
  transcripts: PlacedTranscript[],
  recording: { start: number; end: number },
): VttCue[] {
  const taken: VttCue[] = [];
  for (const t of transcripts) {
    const shift = Math.abs(t.start - recording.start) <= SAME_START_TOLERANCE_MS
      ? 0
      : (t.start - recording.start) / 1000;
    t.cues.forEach((cue, i) => {
      if (t.used[i]) return;
      const mid = t.start + ((cue.start + cue.end) / 2) * 1000;
      const inside = shift === 0
        ? mid >= recording.start - SAME_START_TOLERANCE_MS && mid <= recording.end + SAME_START_TOLERANCE_MS
        : mid >= recording.start && mid <= recording.end;
      if (!inside) return;
      t.used[i] = true;
      taken.push({ ...cue, start: cue.start + shift, end: cue.end + shift });
    });
  }
  return taken.sort((a, b) => a.start - b.start);
}

/** The cues no recording took, per transcript, still on that transcript's clock. */
export function leftoverCues(t: PlacedTranscript): VttCue[] {
  return t.cues.filter((_, i) => !t.used[i]);
}

/** A run of segments, timed from `start` (epoch ms). */
export interface TimedPiece {
  start: number;
  segments: TranscriptSegment[];
}

/**
 * All pieces on one transcript, timed from the first of them, in order of time.
 * Returns the meeting's length as well: from the first piece's start to the
 * last segment's end.
 */
export function joinPieces(pieces: TimedPiece[]): { segments: TranscriptSegment[]; durationSeconds: number | null } {
  const filled = pieces.filter((p) => p.segments.length > 0);
  if (filled.length === 0) return { segments: [], durationSeconds: null };
  const origin = Math.min(...filled.map((p) => p.start));
  const segments = filled
    .flatMap((p) => {
      const offset = (p.start - origin) / 1000;
      return p.segments.map((s) => ({ ...s, start: s.start + offset, end: s.end + offset }));
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const last = segments.reduce((max, s) => (s.end > max ? s.end : max), 0);
  return { segments, durationSeconds: last > 0 ? Math.round(last) : null };
}

/**
 * Anonymous labels ("Taler 1") from two separately diarized recordings do not
 * name the same person, so from the second such recording on they say which
 * part they came from. Named speakers (from Teams) are left alone.
 */
export function labelPart(segments: TranscriptSegment[], part: number, named: Set<string>): TranscriptSegment[] {
  if (part <= 1) return segments;
  return segments.map((s) => (named.has(s.speaker) ? s : { ...s, speaker: `${s.speaker} (del ${part})` }));
}

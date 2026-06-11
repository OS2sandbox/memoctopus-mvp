import type { TranscriptSegment } from '@/types';
import type { SpeakerTurn } from '@/lib/ai/diarization';
import { speakerLabel } from './speaker-labels';

// Merges acoustic diarization output (speaker turns over the full recording) onto
// the already-transcribed segments. hviske produces no speaker labels — every
// segment arrives as 'Taler 1' — so diarization runs as a separate pass and we
// relabel each segment here by time-overlap. Both timebases are recording-seconds
// (segment timestamps come from energyVAD wall-clock; turns come from a single
// full-audio pass), so a plain overlap match lines them up.

// Overlap (in seconds) between two [start, end] intervals; 0 if they don't touch.
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// Assigns each segment the speaker of the turn it overlaps most. Raw pyannote
// labels (SPEAKER_00, SPEAKER_01, …) are remapped to the app's Danish convention
// (Taler 1, Taler 2, …) in order of first appearance across the assigned segments,
// so labels are stable, 1-indexed, and match what SpeakerRow renders.
//
// Segments with no overlapping turn inherit the previous segment's speaker (the
// conversation rarely changes speaker during a gap the diarizer couldn't place);
// the very first such segment falls back to the first speaker. When `turns` is
// empty (diarization unavailable or failed), segments are returned unchanged.
export function assignSpeakers(
  segments: TranscriptSegment[],
  turns: SpeakerTurn[],
): TranscriptSegment[] {
  if (turns.length === 0) return segments;

  const labelMap = new Map<string, string>();
  const labelFor = (rawSpeaker: string): string => {
    let label = labelMap.get(rawSpeaker);
    if (!label) {
      label = speakerLabel(labelMap.size + 1);
      labelMap.set(rawSpeaker, label);
    }
    return label;
  };

  let lastSpeaker: string | null = null;
  return segments.map((segment) => {
    let bestTurn: SpeakerTurn | null = null;
    let bestOverlap = 0;
    for (const turn of turns) {
      const ov = overlap(segment.start, segment.end, turn.start, turn.end);
      if (ov > bestOverlap) {
        bestOverlap = ov;
        bestTurn = turn;
      }
    }

    const rawSpeaker = bestTurn?.speaker ?? lastSpeaker;
    if (rawSpeaker === null) return segment; // no overlap and no prior speaker — leave as-is
    lastSpeaker = rawSpeaker;
    return { ...segment, speaker: labelFor(rawSpeaker) };
  });
}

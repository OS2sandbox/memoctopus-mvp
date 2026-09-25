import { isDefaultSpeakerLabel } from '@/lib/audio/speaker-labels';
import type { TranscriptSegment } from '@/types';

/**
 * Removes the last `Taler N` placeholders from a Teams transcript.
 *
 * A Teams meeting never needs diarization — Microsoft already says who spoke
 * when — so every segment should carry a display name. Two gaps let the generic
 * placeholder through anyway:
 *
 *   - a cue with no `<v Name>` voice span (Teams emits a few, typically for the
 *     first words of a meeting before it has attributed a stream), and
 *   - a transcribed segment that lands outside every cue it could be matched to.
 *
 * Either way the review screen showed "Taler 1" beside two named participants
 * and counted it as an unrecognised voice, which is worse than useless: the name
 * is not unknown, it is simply missing from that one cue.
 *
 * The fix is positional, not statistical. A gap is filled from the nearest named
 * segment — the one before it, or the one after it when the gap is at the very
 * start. In a transcript where speech is attributed either side of it, that is
 * who was talking. When nothing is named at all (mode 3: a recording with no
 * Teams transcript) there is nothing to fill from and the segments are returned
 * untouched, placeholders and all — that meeting genuinely has unknown voices.
 */
export function fillSpeakerNames(segments: TranscriptSegment[]): TranscriptSegment[] {
  const isNamed = (segment: TranscriptSegment): boolean =>
    segment.speaker.trim() !== '' && !isDefaultSpeakerLabel(segment.speaker);

  if (!segments.some(isNamed)) return segments;

  const filled = segments.map((segment) => ({ ...segment }));

  // Forward: a gap belongs to whoever was last speaking.
  let previous: string | null = null;
  for (const segment of filled) {
    if (isNamed(segment)) previous = segment.speaker;
    else if (previous) segment.speaker = previous;
  }

  // Backward: the leading gap has nobody before it, so it takes the first name
  // that follows. (After the forward pass this is the only kind of gap left.)
  let next: string | null = null;
  for (let i = filled.length - 1; i >= 0; i -= 1) {
    if (isNamed(filled[i])) next = filled[i].speaker;
    else if (next) filled[i].speaker = next;
  }

  return filled;
}

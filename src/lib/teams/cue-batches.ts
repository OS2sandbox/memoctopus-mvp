import type { VttCue } from './vtt';

// Where a Teams recording is cut up before it goes to hviske.
//
// The generic path (`prepareVadBatches`) runs an energy VAD over the audio and
// then SPLICES the surviving fragments together into 27 s windows — nineteen
// disjoint pieces from across a two-minute meeting arrive as one continuous WAV.
// A browser microphone recording survives that; a Teams cloud recording does not.
// Measured against the production hviske on a real Teams recording (16 kHz mono
// AAC at 22 kbit/s), the spliced window came back transcribing only its loudest
// passage and silently skipping the quieter fragments — the first sixty seconds
// of the meeting were simply absent from the referat.
//
// The same audio cut into CONTIGUOUS slices along Teams' own transcript cues came
// back complete, with no repetition loops and no subtitle-credit hallucinations.
// So for the recording+transcript mode we cut where Microsoft says people spoke
// instead of guessing with a VAD: every slice is an unbroken stretch of real
// conversation, which is what the model was trained on, and its boundaries line
// up with speaker turns — so the speaker of each resulting segment is read off
// the cue rather than guessed by time-overlap.

/** Longest slice handed to hviske. Matches BATCH_DURATION_S. */
export const MAX_BATCH_SECONDS = 27;

/** A silence longer than this ends a slice: nobody is mid-sentence across it. */
export const CUE_GAP_SECONDS = 5;

/** Context kept either side of a slice, so no word is clipped at the boundary. */
export const CUE_PAD_SECONDS = 0.6;

/**
 * Very short slices are where the model invents subtitle credits, so a lone
 * two-word cue is padded out to at least this much surrounding audio.
 */
export const MIN_BATCH_SECONDS = 3;

export interface CueBatch {
  /** Slice bounds in recording seconds. */
  start: number;
  end: number;
  /** The cues this slice covers, in order — the text is divided among them. */
  cues: VttCue[];
}

/**
 * Groups cues into contiguous, transcribable slices of the recording.
 *
 * A new slice is started when the silence since the previous cue exceeds
 * {@link CUE_GAP_SECONDS}, or when the cue would push the slice past
 * {@link MAX_BATCH_SECONDS}. Cues with no text (Teams emits a few) are dropped;
 * cues with a broken or inverted timing are dropped too rather than producing a
 * slice ffmpeg cannot cut.
 *
 * Pure, so the grouping rules can be pinned down by tests.
 */
export function planCueBatches(cues: VttCue[], durationSeconds: number | null): CueBatch[] {
  const usable = cues
    .filter((cue) => cue.text.trim() !== '')
    .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
    .sort((a, b) => a.start - b.start);
  if (usable.length === 0) return [];

  const limit = durationSeconds && durationSeconds > 0 ? durationSeconds : Infinity;
  const groups: VttCue[][] = [];

  for (const cue of usable) {
    const current = groups[groups.length - 1];
    if (current) {
      const last = current[current.length - 1];
      const gap = cue.start - last.end;
      const span = cue.end - current[0].start;
      if (gap <= CUE_GAP_SECONDS && span <= MAX_BATCH_SECONDS) {
        current.push(cue);
        continue;
      }
    }
    groups.push([cue]);
  }

  return groups.map((group) => {
    const first = group[0];
    const last = group[group.length - 1];
    let start = Math.max(0, first.start - CUE_PAD_SECONDS);
    let end = Math.min(limit, last.end + CUE_PAD_SECONDS);

    // Pad a very short slice outwards (never inwards — no cue audio is lost).
    if (end - start < MIN_BATCH_SECONDS) {
      const missing = MIN_BATCH_SECONDS - (end - start);
      start = Math.max(0, start - missing / 2);
      end = Math.min(limit, end + missing / 2);
      if (end - start < MIN_BATCH_SECONDS) start = Math.max(0, end - MIN_BATCH_SECONDS);
    }

    return { start, end, cues: group };
  });
}

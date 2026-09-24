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

/**
 * A silence longer than this ends a slice.
 *
 * Measured, not guessed: at 5 s a two-speaker meeting broke into slices short
 * enough that hviske lost words at their edges ("Velkommen til Sydjurs" alone,
 * with the two "Hej" and a "Thank you" around it gone). At 10 s the same cues
 * merged into one 24 s slice that transcribed all of it. Longer silences inside
 * a slice are no longer a hazard now that {@link MAX_BATCH_SECONDS} caps the span
 * and cleanTranscribedText removes the credits a model emits over them.
 */
export const CUE_GAP_SECONDS = 10;

/** Context kept either side of a slice, so no word is clipped at the boundary. */
export const CUE_PAD_SECONDS = 0.6;

/**
 * Very short slices are where the model invents subtitle credits and mangles what
 * it does hear, so a lone short cue is padded out to at least this much audio.
 *
 * Also measured: a 3.1 s slice of "Hvad er du joine mit møde, Peter." came back
 * as "Jørgen mit mødepiller"; the same cue in an 8 s slice came back as "Vær du
 * joinde mit møde Peter?". Whisper needs context either side of a short utterance.
 */
export const MIN_BATCH_SECONDS = 8;

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
      // Teams cues OVERLAP — it transcribes each participant's own stream, so two
      // people talking at once are two cues covering the same instant. The gap is
      // therefore measured against the furthest end so far, not the previous cue's.
      const reached = current.reduce((max, c) => (c.end > max ? c.end : max), current[0].end);
      const gap = cue.start - reached;
      const span = Math.max(cue.end, reached) - current[0].start;
      if (gap <= CUE_GAP_SECONDS && span <= MAX_BATCH_SECONDS) {
        current.push(cue);
        continue;
      }
    }
    groups.push([cue]);
  }

  // A group's own span, before padding — the bounds the neighbours are clamped to.
  const spans = groups.map((group) => ({
    from: group[0].start,
    to: group.reduce((max, cue) => (cue.end > max ? cue.end : max), group[0].end),
  }));

  return groups.map((group, i) => {
    // Two slices must never cover the same audio: a word caught by both would be
    // transcribed twice and appear twice in the referat. Each slice may grow into
    // at most half of the silence on either side, so neighbours meet and never
    // overlap — whatever the constants above are tuned to.
    const floor = i > 0 ? spans[i - 1].to + (spans[i].from - spans[i - 1].to) / 2 : 0;
    const ceiling =
      i + 1 < spans.length ? spans[i].to + (spans[i + 1].from - spans[i].to) / 2 : limit;

    let start = Math.max(floor, spans[i].from - CUE_PAD_SECONDS);
    let end = Math.min(ceiling, spans[i].to + CUE_PAD_SECONDS);

    // Pad a very short slice outwards (never inwards — no cue audio is lost).
    if (end - start < MIN_BATCH_SECONDS) {
      const missing = MIN_BATCH_SECONDS - (end - start);
      start = Math.max(floor, start - missing / 2);
      end = Math.min(ceiling, end + missing / 2);
      // One side ran out of room — take what is left on the other.
      if (end - start < MIN_BATCH_SECONDS) {
        start = Math.max(floor, end - MIN_BATCH_SECONDS);
        end = Math.min(ceiling, start + MIN_BATCH_SECONDS);
      }
    }

    return { start, end, cues: group };
  });
}

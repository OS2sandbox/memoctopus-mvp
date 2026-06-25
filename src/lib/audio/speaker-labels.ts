// Single source of truth for the Danish speaker-label convention. Transcription
// produces single-speaker output (everything is the first speaker) and diarization
// later relabels segments per speaker — both must agree on the wording, so the
// label lives here rather than as scattered 'Taler 1' string literals.

// The label given to the Nth speaker (1-indexed): speakerLabel(1) === 'Taler 1'.
export function speakerLabel(n: number): string {
  return `Taler ${n}`;
}

// The default applied before diarization, when there is only one known speaker.
export const DEFAULT_SPEAKER_LABEL = speakerLabel(1);

// A speaker label is "unassigned" while it's still a generic 'Taler N' placeholder
// produced by transcription/diarization. Once the user renames it to a real person
// (a participant), it no longer matches — which is how the review screen knows which
// speakers still need to be connected to a participant.
export function isDefaultSpeakerLabel(label: string): boolean {
  return /^Taler \d+$/.test(label.trim());
}

// The lowest-numbered 'Taler N' not already present in `used` — for handing an
// unlinked voice back to the unmatched pool with a fresh, non-colliding label.
export function nextAvailableSpeakerLabel(used: Set<string>): string {
  let n = 1;
  while (used.has(speakerLabel(n))) n++;
  return speakerLabel(n);
}

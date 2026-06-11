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

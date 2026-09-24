// Whisper-family models degenerate in two characteristic ways on quiet, noisy or
// heavily-compressed audio, and both were reaching the user's referat verbatim:
//
//  1. A runaway repetition loop — "Det er fastet. Det er fastet. Det er fastet. …"
//     for the rest of the window, sometimes hundreds of times.
//  2. Subtitle credits learned from the training data, emitted over near-silence:
//     "Danske tekster af Jesper Buhl Scandinavian Text Service 2018",
//     "Tak skal I have.", "Undertekster af Nicolai Winther".
//
// Both were observed on a real Microsoft Teams cloud recording (16 kHz mono AAC at
// 22 kbit/s — a far poorer signal than the browser's own microphone capture).
//
// The old guard answered a single boolean and the caller then dropped the WHOLE
// batch, which threw away the real words that preceded the loop: a 27 s window that
// transcribed correctly for eight seconds and then span out contributed nothing at
// all. `cleanTranscribedText` instead keeps the good prefix and cuts the loop off.

/** Phrases a Whisper-family model emits over silence, matched on the whole line. */
const CREDIT_PHRASES = [
  /^tak skal (du|i) have\.?$/i,
  /^tak for (at se med|i dag)\.?$/i,
  /^(danske )?(under)?tekster af .*$/i,
  /^(danske )?tekster? .*scandinavian text service.*$/i,
  /^undertekster? .*$/i,
  /^subtitles by .*$/i,
  /^amara\.org.*$/i,
  /^tekstning af .*$/i,
];

/** A repeated run this long or longer is a loop, not speech. */
const MAX_WORD_RUN = 3;
/** …and so is a phrase (2–6 words) repeated this many times back to back. */
const MAX_PHRASE_RUN = 3;

function isCreditPhrase(text: string): boolean {
  const line = text.trim().replace(/\s+/g, ' ');
  return CREDIT_PHRASES.some((re) => re.test(line));
}

/**
 * Index of the first word at which the output degenerates into repetition, or
 * `words.length` when it never does.
 *
 * Two shapes are detected: the same word repeated (`så så så så`) and a short
 * phrase repeated (`det er noget, der er noget, der er noget`). Both are cut at
 * the start of the repetition, so the first occurrence is kept — it is usually
 * real speech, and only the echo after it is not.
 */
export function degenerationStart(words: string[]): number {
  const lower = words.map((w) => w.toLowerCase().replace(/[.,!?;:]+$/, ''));

  // Single word repeated MAX_WORD_RUN+ times in a row.
  let runStart = 0;
  for (let i = 1; i <= lower.length; i++) {
    if (i < lower.length && lower[i] === lower[runStart]) continue;
    if (i - runStart > MAX_WORD_RUN) return runStart + 1;
    runStart = i;
  }

  // Phrase of 2–6 words repeated MAX_PHRASE_RUN+ times back to back.
  for (let size = 2; size <= 6; size++) {
    for (let i = 0; i + size * (MAX_PHRASE_RUN + 1) <= lower.length; i++) {
      let reps = 1;
      while (
        i + size * (reps + 1) <= lower.length &&
        lower.slice(i + size * reps, i + size * (reps + 1)).join(' ') ===
          lower.slice(i, i + size).join(' ')
      ) {
        reps++;
      }
      if (reps > MAX_PHRASE_RUN) return i + size;
    }
  }

  return words.length;
}

/**
 * The usable part of one transcription response: credits dropped, a repetition
 * loop cut off at its first echo. Returns '' when nothing usable is left.
 */
export function cleanTranscribedText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (isCreditPhrase(trimmed)) return '';

  const words = trimmed.split(/\s+/).filter(Boolean);
  const cut = degenerationStart(words);
  const kept = words.slice(0, cut).join(' ').trim();
  if (!kept) return '';
  // A window whose entire content was the loop is worth nothing; one that span out
  // after a couple of words is almost certainly noise too.
  if (cut < words.length && words.slice(0, cut).length < 2) return '';
  return isCreditPhrase(kept) ? '' : kept;
}

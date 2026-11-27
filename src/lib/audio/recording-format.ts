/**
 * MediaRecorder mime-type selection with a mobile-aware fallback chain.
 *
 * Desktop Chrome/Firefox record `audio/webm;codecs=opus`, but iOS Safari does
 * NOT support webm in MediaRecorder — it only produces `audio/mp4` (AAC). The
 * old code hard-coded webm and silently failed to produce a usable file on
 * iPhone/iPad. We probe candidates in priority order and fall back to mp4, then
 * to the browser default (empty string lets MediaRecorder choose).
 */

// Ordered best → worst. webm/opus is smallest & best supported on desktop;
// mp4 is the iOS Safari path; the trailing '' means "let the browser decide".
const CANDIDATE_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/ogg;codecs=opus',
] as const;

type IsTypeSupported = (mimeType: string) => boolean;

function defaultIsTypeSupported(mimeType: string): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function' &&
    MediaRecorder.isTypeSupported(mimeType)
  );
}

/**
 * Returns the first supported mime type for MediaRecorder, or '' if none of the
 * candidates are supported (caller should pass no `mimeType` option so the
 * browser picks its own default rather than throwing).
 */
export function pickRecordingMimeType(
  isTypeSupported: IsTypeSupported = defaultIsTypeSupported,
): string {
  for (const type of CANDIDATE_MIME_TYPES) {
    if (isTypeSupported(type)) return type;
  }
  return '';
}

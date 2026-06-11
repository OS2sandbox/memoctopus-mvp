// Minimal same-tab pub/sub for "a meeting's transcript changed underneath you".
// Used so the review screen can refresh when a background task (e.g. diarization
// landing after the recording already navigated to review) patches the stored
// transcript. Storage is plain IndexedDB with no change notifications, so we emit
// a window CustomEvent the review screen subscribes to.

const EVENT = 'referat:transcript-updated';

export function notifyTranscriptUpdated(meetingId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { meetingId } }));
}

// Subscribe to updates for one meeting. Returns an unsubscribe function.
export function onTranscriptUpdated(meetingId: string, cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    if ((e as CustomEvent<{ meetingId: string }>).detail?.meetingId === meetingId) cb();
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

/**
 * Our meeting ids (the browser's IndexedDB id, or one minted for Outlook) become
 * file names in the pending stash and in the pipeline's scratch directory, so only
 * this alphabet is accepted: anything else (`../…`) is refused, at every boundary,
 * rather than relying on a downstream call happening to validate first.
 */
const SAFE_MEETING_ID = /^[\w-]+$/;

export function isSafeMeetingId(meetingId: string): boolean {
  return SAFE_MEETING_ID.test(meetingId);
}

export function assertSafeMeetingId(meetingId: string): void {
  if (!isSafeMeetingId(meetingId)) {
    throw new Error(`Invalid meetingId: ${meetingId}`);
  }
}

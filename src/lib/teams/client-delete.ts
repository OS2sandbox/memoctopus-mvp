import { deleteMeeting, getMeeting } from '@/lib/storage';

/**
 * The one way to delete a meeting from the UI.
 *
 * A Graph-managed meeting also has a row on the server, and that row is what
 * keeps the poller downloading the recording and stashing a transcript — and
 * what left Teams armed. Deleting only the local record leaves all of that
 * running for a meeting the user believes is gone, so the server row goes first.
 *
 * The local record is kept, and this throws, unless the server confirmed: a 2xx,
 * or a 404 (no row, so nothing keeps collecting). A network error, a 5xx or an
 * expired session leaves the meeting in place so the user can try again —
 * "delete" has to mean "stops collecting".
 *
 * The flag is read from the stored meeting rather than passed in, so no call
 * site can forget it. Callers show their own error when this throws.
 */
export async function deleteMeetingAndUnregister(id: string): Promise<void> {
  const meeting = await getMeeting(id);
  if (meeting?.graphManaged) {
    const res = await fetch(`/api/teams/meetings/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Kunne ikke afmelde mødet hos serveren (${res.status}).`);
    }
  }
  await deleteMeeting(id);
}

import { GraphError, graphFetch, graphJson } from './graph-client';

// Removing a transcribed recording from the organizer's OneDrive.
//
// Graph has no delete on callRecording — list, get and content are all there is —
// so the file has to be found and deleted through the drive API instead. Nothing on
// a callRecording names its driveItem either, which leaves identifying the file by
// what we know for certain about it: it sits in the drive's Recordings folder
// (addressed as a special folder, so a renamed or localised "Optagelser" still
// resolves) and it is, byte for byte, what we downloaded.
//
// Matching on the exact byte count is deliberately strict. A file name carries the
// meeting subject and a timestamp, and matching on those could delete a recording
// this run never fetched — a different occurrence of a series, or one the user made
// themselves. A size that fits to the byte cannot be another meeting's by accident,
// and when it fits more than one file nothing is deleted at all.

export type RecordingCleanupResult =
  /** Gone for good (permanentDelete). */
  | 'deleted'
  /** Graph refused the permanent delete; the file is in the recycle bin instead. */
  | 'recycled'
  /** No file of that size in the user's Recordings folder. */
  | 'not_found'
  /** More than one file of that size — refusing to guess. */
  | 'ambiguous';

interface DriveChild {
  id?: string;
  size?: number;
  file?: unknown;
  parentReference?: { driveId?: string };
}

interface DriveChildren {
  value?: DriveChild[];
  '@odata.nextLink'?: string;
}

/** 200 per page; a Recordings folder beyond this is not searched further. */
const MAX_PAGES = 25;

const CHILDREN_PATH =
  '/me/drive/special/recordings/children?$select=id,size,file,parentReference&$top=200';

async function findBySize(userId: string, bytes: number): Promise<DriveChild[]> {
  const matches: DriveChild[] = [];
  let next: string | undefined = CHILDREN_PATH;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const body: DriveChildren = await graphJson<DriveChildren>(userId, next);
    for (const item of body.value ?? []) {
      if (item.id && item.file && item.size === bytes) matches.push(item);
    }
    next = body['@odata.nextLink'];
  }
  return matches;
}

function itemPath(item: DriveChild): string {
  const id = encodeURIComponent(item.id!);
  const driveId = item.parentReference?.driveId;
  return driveId ? `/drives/${encodeURIComponent(driveId)}/items/${id}` : `/me/drive/items/${id}`;
}

/**
 * Deletes the recording of exactly `bytes` bytes from the signed-in user's
 * Recordings folder. Throws a GraphError when Graph could not be asked (throttled,
 * signed out, forbidden) — the caller decides whether that is worth another try.
 *
 * Permanent delete first, because a recycle bin keeps the file for 93 more days.
 * A tenant can refuse that (a retention policy or hold on the drive); the ordinary
 * delete is then the most this app is allowed to do, and what happens to the file
 * next is the tenant's own retention rules at work.
 */
export async function deleteRecordingFromDrive(
  userId: string,
  bytes: number,
): Promise<RecordingCleanupResult> {
  let matches: DriveChild[];
  try {
    matches = await findBySize(userId, bytes);
  } catch (err) {
    // No Recordings folder at all: this user has never had a recording stored.
    if (err instanceof GraphError && err.code === 'not_found') return 'not_found';
    throw err;
  }
  if (matches.length === 0) return 'not_found';
  if (matches.length > 1) return 'ambiguous';

  const path = itemPath(matches[0]);
  try {
    await graphFetch(userId, `${path}/permanentDelete`, { method: 'POST' });
    return 'deleted';
  } catch (err) {
    if (!(err instanceof GraphError)) throw err;
    if (err.code === 'not_found') return 'deleted'; // someone got there first
    if (err.retryable || err.code === 'reauth_required') throw err;
  }

  try {
    await graphFetch(userId, path, { method: 'DELETE' });
  } catch (err) {
    if (!(err instanceof GraphError && err.code === 'not_found')) throw err;
  }
  return 'recycled';
}

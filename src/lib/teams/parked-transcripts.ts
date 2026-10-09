import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';
import type { TranscriptSegment } from '@/types';

// Where a finished Teams transcript waits for its owner's browser.
//
// Meetings live in the browser, and the pipeline finishes long after the tab that
// armed the meeting was closed. The on-disk stash (pending-artifacts.ts) covers that
// gap for an hour, which was enough while a late user could simply have Teams'
// artifacts fetched again. It no longer is: the recording is now deleted from
// OneDrive as soon as it is transcribed, and Teams' own transcript is embedded in
// that file, so an uncollected transcript that is swept is gone for good.
//
// So once a run is ready, its result moves here: one row per meeting in the owner's
// own schema, encrypted, kept until the browser acknowledges it or for
// PARKED_TTL_DAYS. The per-user schema is the access control — there is no owner
// file to check, and no way to address another user's row.

/** How long an uncollected transcript is kept. */
export const PARKED_TTL_DAYS = 30;

export interface ParkedTranscript {
  segments: TranscriptSegment[];
  /** Whether speaker turns were merged in (false → the client may diarize itself). */
  diarized: boolean;
  /** Speaker names from Teams; they pre-fill the participant list in Gennemgang. */
  participants: string[];
  durationSeconds: number | null;
}

// ─── Encryption at rest ──────────────────────────────────────────────────────
// A waiting transcript is the raw, unreviewed text of a meeting, and it ends up in
// every database dump taken while it waits. AES-256-GCM under a key derived from
// BETTER_AUTH_SECRET, the secret the OAuth tokens in `accounts` are already
// encrypted with — so a dump alone exposes neither. The same caveat applies:
// rotating the secret makes what is parked unreadable.

const FORMAT = 'v1';

function key(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set; refusing to store a transcript unencrypted');
  return Buffer.from(hkdfSync('sha256', secret, 'os2taletiltekst', 'parked-transcript-v1', 32));
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [FORMAT, iv, cipher.getAuthTag(), body]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64')))
    .join('.');
}

export function open(sealed: string): string {
  const [format, iv, tag, body] = sealed.split('.');
  if (format !== FORMAT || !iv || !tag || body === undefined) {
    throw new Error('Unrecognised parked transcript format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/** Parks (or replaces) a meeting's finished transcript. */
export async function parkTranscript(
  userId: string,
  meetingId: string,
  transcript: ParkedTranscript,
): Promise<void> {
  await queryUserSchema(
    userId,
    `INSERT INTO parked_transcripts (meeting_id, payload, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (meeting_id) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()`,
    [meetingId, seal(JSON.stringify(transcript))],
  );
}

/**
 * The parked transcript, or null when there is none — or none that can be read: a
 * row sealed under a secret that has since been rotated is as lost as a missing
 * one, and must not turn every poll of the hand-off routes into a 500.
 */
export async function readParkedTranscript(
  userId: string,
  meetingId: string,
): Promise<ParkedTranscript | null> {
  const row = await queryUserSchemaOne<{ payload: string }>(
    userId,
    `SELECT payload FROM parked_transcripts WHERE meeting_id = $1`,
    [meetingId],
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(open(row.payload)) as Partial<ParkedTranscript>;
    return {
      segments: parsed.segments ?? [],
      diarized: parsed.diarized ?? false,
      participants: parsed.participants ?? [],
      durationSeconds: parsed.durationSeconds ?? null,
    };
  } catch (err) {
    console.error('[parked-transcripts] could not read the parked transcript for', meetingId, err);
    return null;
  }
}

/** Whether anything is parked for the meeting, without decrypting it. */
export async function hasParkedTranscript(userId: string, meetingId: string): Promise<boolean> {
  const row = await queryUserSchemaOne(
    userId,
    `SELECT 1 FROM parked_transcripts WHERE meeting_id = $1`,
    [meetingId],
  );
  return row !== null;
}

/** The browser has saved it (or the user forgot the meeting): remove the server copy. */
export async function deleteParkedTranscript(userId: string, meetingId: string): Promise<void> {
  await queryUserSchema(userId, `DELETE FROM parked_transcripts WHERE meeting_id = $1`, [meetingId]);
}

/** Drops this user's transcripts nobody collected within PARKED_TTL_DAYS. */
export async function sweepParkedTranscripts(userId: string): Promise<void> {
  await queryUserSchema(
    userId,
    `DELETE FROM parked_transcripts WHERE created_at < NOW() - $1 * INTERVAL '1 day'`,
    [PARKED_TTL_DAYS],
  );
}

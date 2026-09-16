import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { GraphError } from './graph-client';
import { listArtifacts, pickArtifact, downloadTranscriptVtt, downloadRecording } from './artifacts';
import { parseVtt, turnsFromVtt, segmentsFromVtt, speakersFromVtt, type VttCue } from './vtt';
import {
  storePendingTranscript,
  readPendingTranscript,
  readPendingMeta,
  markNoRecording,
  setMeetingOwner,
} from '@/lib/pending-artifacts';
import { transcribeRecording } from '@/lib/transcribe-recording';
import { withMeetingLock } from './meeting-lock';

// One meeting's worth of work: ask Graph what artifacts exist, decide which of the
// three processing modes applies, and land the result in the pending stash the
// client already knows how to collect (/api/meetings/[id]/pending-audio + /pending-transcript).
//
// Idempotent: a meeting whose stash is already 'ready' is not reprocessed, and a
// run in flight reports 'pending' rather than starting a second download.

export type ArtifactMode = 'prefer-recording' | 'transcript-only';

export type ProcessingMode = 'recording+transcript' | 'transcript-only' | 'recording-only';

export type PipelineOutcome =
  | {
      status: 'ready';
      mode: ProcessingMode;
      speakers: string[];
      transcriptId: string | null;
      recordingId: string | null;
    }
  | { status: 'pending' }
  | { status: 'failed'; reason: string };

export interface PipelineMeeting {
  id: string;
  graphMeetingId: string;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  /** Poll attempts so far — the escape hatch out of the transcript-only grace. */
  attempts?: number;
}

/**
 * Teams publishes the transcript before it has finished processing the
 * recording. In `prefer-recording` we therefore wait this long past the
 * scheduled end before settling for transcript-only, or the deployment silently
 * degrades to mode 2 for most meetings.
 */
export const RECORDING_GRACE_MS = 30 * 60 * 1000;

/** …and the same escape by attempt count, for meetings with no schedule. */
export const RECORDING_GRACE_ATTEMPTS = 15;

/**
 * A stash stuck in `processing` for longer than this belonged to a run that
 * died (deploy, crash, OOM). Treat it as reprocessable rather than as a
 * permanent "pending" that no later run can ever get past.
 */
export const PROCESSING_STALE_MS = 30 * 60 * 1000;

/** Same rule as the pending stash: ids become file names, so keep them inert. */
export function assertSafeMeetingId(meetingId: string): void {
  if (!/^[\w-]+$/.test(meetingId)) {
    throw new Error(`Invalid meetingId: ${meetingId}`);
  }
}

/**
 * Deployment-wide artifact policy. `transcript-only` is for customers who forbid
 * recordings: Teams' own transcript is used verbatim and no mp4 is ever fetched.
 */
export function artifactMode(): ArtifactMode {
  const raw = process.env.TEAMS_ARTIFACT_MODE?.trim().toLowerCase() || undefined;
  return raw === 'transcript-only' ? 'transcript-only' : 'prefer-recording';
}

function tmpRoot(): string {
  const base = process.env.AUDIO_STORAGE_PATH?.trim() || path.join(process.cwd(), 'audio-storage');
  return path.join(base, 'teams-tmp');
}

/** Duration of the meeting according to the transcript: the last cue's end. */
function durationFromCues(cues: VttCue[]): number | null {
  if (cues.length === 0) return null;
  const end = cues.reduce((max, cue) => (cue.end > max ? cue.end : max), 0);
  return end > 0 ? Math.round(end) : null;
}

/**
 * Teams recordings are mp4. hviske wants 16 kHz mono PCM, and the VAD batcher
 * decodes whatever it is given, so we normalise once here — file in, file out,
 * nothing buffered (a recording can be hundreds of MB).
 */
export function transcodeToWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-nostdin',
      '-y',
      '-i', inputPath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      outputPath,
    ]);

    const errChunks: Buffer[] = [];
    let settled = false;
    ff.stderr?.on('data', (chunk: Buffer) => errChunks.push(Buffer.from(chunk)));

    ff.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (err.code === 'ENOENT') {
        reject(new Error(
          'ffmpeg not found on PATH. Converting the Teams recording requires ffmpeg. ' +
          'Install it locally (macOS: `brew install ffmpeg`); the production Docker image already includes it.',
        ));
        return;
      }
      reject(err);
    });

    ff.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) { resolve(); return; }
      reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errChunks).toString().trim()}`));
    });
  });
}

export async function processTeamsMeeting(
  userId: string,
  meeting: PipelineMeeting,
  now: Date = new Date(),
): Promise<PipelineOutcome> {
  // The id becomes file names in the pending stash and the scratch directory,
  // so it is validated here as well as at the route boundary — a new entry
  // point into the pipeline must not be able to reopen path traversal.
  assertSafeMeetingId(meeting.id);

  // Serialise per meeting: the poller and the "Tjek nu" route both land here,
  // and the stash guard below is check-then-act.
  return await withMeetingLock(
    `${userId}:${meeting.id}`,
    () => runPipeline(userId, meeting, now),
    () => ({ status: 'pending' }),
  );
}

async function runPipeline(
  userId: string,
  meeting: PipelineMeeting,
  now: Date,
): Promise<PipelineOutcome> {
  // Idempotency: a finished (or in-flight) run is never redone. The stash is the
  // single source of truth here — it survives a server restart, the poller's
  // in-memory state does not.
  const existing = await readPendingTranscript(meeting.id);
  if (existing?.status === 'ready') {
    const meta = await readPendingMeta(meeting.id);
    return {
      status: 'ready',
      mode: meta?.hasRecording ? 'recording+transcript' : 'transcript-only',
      speakers: meta?.participants ?? [],
      transcriptId: null,
      recordingId: null,
    };
  }
  if (existing?.status === 'processing') {
    const age = now.getTime() - (existing.createdAt ?? 0);
    if (age < PROCESSING_STALE_MS) return { status: 'pending' };
    // Older than the timeout: the run that wrote it is gone. Fall through and
    // redo the work rather than leaving the meeting pending forever.
  }

  // Bind the stash to its owner BEFORE anything is written into it. Both
  // hand-off routes (pending-audio, pending-transcript) deny by default when
  // no owner file exists, so without this the meeting's real owner is answered
  // 404 / { status: 'none' } and the hand-off can never complete.
  await setMeetingOwner(meeting.id, userId);

  let artifacts;
  try {
    artifacts = await listArtifacts(userId, meeting.graphMeetingId);
  } catch (err) {
    // A dead refresh token is the poller's business (state needs_reauth), so it
    // propagates; a throttle or a gateway error is "not yet", not a failure;
    // everything else is this meeting's own failure.
    if (err instanceof GraphError && err.code === 'reauth_required') throw err;
    // So is a tenant that has switched off Graph access to transcripts: it is not
    // this meeting's fault and no retry can fix it, so let the poller turn it into
    // the message that names the admin guide instead of leaking Graph's English.
    if (err instanceof GraphError && err.code === 'transcripts_disabled') throw err;
    if (err instanceof GraphError && err.retryable) return { status: 'pending' };
    if (err instanceof GraphError) return { status: 'failed', reason: err.message };
    throw err;
  }

  const window =
    meeting.scheduledStart && meeting.scheduledEnd
      ? { start: meeting.scheduledStart, end: meeting.scheduledEnd }
      : undefined;
  const transcript = pickArtifact(artifacts.transcripts, window);
  const recording = artifactMode() === 'transcript-only' ? null : pickArtifact(artifacts.recordings, window);

  if (!transcript && !recording) return { status: 'pending' };

  // Teams publishes the transcript first and the recording minutes later. Taking
  // the transcript-only branch the moment it appears would permanently lock a
  // prefer-recording deployment out of hviske (the run is idempotent), so hold
  // out for the recording until the grace period is spent.
  if (transcript && !recording && artifactMode() === 'prefer-recording' && !graceElapsed(meeting, now)) {
    return { status: 'pending' };
  }

  await storePendingTranscript(meeting.id, { status: 'processing' });

  try {
    if (transcript && recording) {
      return await runRecordingWithTranscript(userId, meeting, transcript.id, recording.id);
    }
    if (transcript) {
      return await runTranscriptOnly(userId, meeting, transcript.id);
    }
    return await runRecordingOnly(userId, meeting, recording!.id);
  } catch (err) {
    await storePendingTranscript(meeting.id, { status: 'failed' }).catch(() => {});
    if (err instanceof GraphError && err.code === 'reauth_required') throw err;
    if (err instanceof GraphError && err.code === 'transcripts_disabled') throw err;
    if (err instanceof GraphError && err.retryable) return { status: 'pending' };
    const reason = err instanceof Error ? err.message : 'Ukendt fejl under hentning fra Microsoft Teams';
    console.error(`[teams-pipeline] ${meeting.id} failed:`, err);
    return { status: 'failed', reason };
  }
}

/** True once waiting any longer for Teams to publish the recording is futile. */
function graceElapsed(meeting: PipelineMeeting, now: Date): boolean {
  if ((meeting.attempts ?? 0) >= RECORDING_GRACE_ATTEMPTS) return true;
  if (!meeting.scheduledEnd) return false;
  return now.getTime() >= meeting.scheduledEnd.getTime() + RECORDING_GRACE_MS;
}

// Mode 1 — the target: Teams' recording transcribed by hviske (good Danish), with
// the speaker timeline lifted from Teams' own transcript (real display names).
//
// The recording is transcribed and then dropped. It is deliberately never stashed
// for the browser: Graph publishes nothing until the meeting has ended, so nobody
// can follow a meeting live here, and a copy of the raw audio in IndexedDB would
// then outlive the transcription it was fetched for with no user able to act on it.
// The only thing handed over is the transcript, plus the speaker names and duration
// that pre-fill Gennemgang.
async function runRecordingWithTranscript(
  userId: string,
  meeting: PipelineMeeting,
  transcriptId: string,
  recordingId: string,
): Promise<PipelineOutcome> {
  const cues = parseVtt(await downloadTranscriptVtt(userId, meeting.graphMeetingId, transcriptId));
  const speakers = speakersFromVtt(cues);
  const wav = await fetchRecordingAsWav(userId, meeting, recordingId);

  await transcribeRecording(meeting.id, wav, 'audio/wav', {
    turns: turnsFromVtt(cues),
    preserveNames: true,
  });
  await assertTranscribed(meeting.id);
  // After the verdict, so a run that failed transcription never advertises itself
  // as finished-with-no-audio to a client that would then stop waiting.
  await markNoRecording(meeting.id, {
    participants: speakers,
    durationSeconds: durationFromCues(cues),
  });

  return { status: 'ready', mode: 'recording+transcript', speakers, transcriptId, recordingId };
}

// Mode 2 — no audio ever touches disk: Teams' transcript text is the transcript.
async function runTranscriptOnly(
  userId: string,
  meeting: PipelineMeeting,
  transcriptId: string,
): Promise<PipelineOutcome> {
  const cues = parseVtt(await downloadTranscriptVtt(userId, meeting.graphMeetingId, transcriptId));
  const segments = segmentsFromVtt(cues);
  if (segments.length === 0) {
    throw new Error('Transskriptionen fra Teams var tom.');
  }

  // The audio route needs a meta record, or the client polls 404 forever. This is
  // the existing "finished with nothing to transcribe" marker, so the pending-audio route
  // answers { status: 'no-recording' } and the client goes straight to the
  // transcript hand-off instead of waiting for a blob.
  const speakers = speakersFromVtt(cues);
  await markNoRecording(meeting.id, {
    participants: speakers,
    durationSeconds: durationFromCues(cues),
  });
  await storePendingTranscript(meeting.id, { status: 'ready', segments, diarized: true });

  return {
    status: 'ready',
    mode: 'transcript-only',
    speakers,
    transcriptId,
    recordingId: null,
  };
}

// Mode 3 — today's behaviour: hviske plus pyannote's anonymous `Taler N` labels.
async function runRecordingOnly(
  userId: string,
  meeting: PipelineMeeting,
  recordingId: string,
): Promise<PipelineOutcome> {
  const wav = await fetchRecordingAsWav(userId, meeting, recordingId);

  // Transcribed and dropped, as in mode 1 — see the note there.
  await transcribeRecording(meeting.id, wav, 'audio/wav');
  await assertTranscribed(meeting.id);
  await markNoRecording(meeting.id, { participants: [], durationSeconds: null });

  return { status: 'ready', mode: 'recording-only', speakers: [], transcriptId: null, recordingId };
}

// transcribeRecording is fail-soft: it records its own failure in the stash rather
// than throwing, so the pipeline has to read the verdict back to know whether the
// meeting is genuinely ready.
async function assertTranscribed(meetingId: string): Promise<void> {
  const stash = await readPendingTranscript(meetingId);
  if (stash?.status !== 'ready') {
    throw new Error('Transskriptionen af optagelsen fra Teams fejlede.');
  }
}

/** Download the mp4 to a scratch file, transcode, read the wav back, clean up. */
async function fetchRecordingAsWav(
  userId: string,
  meeting: PipelineMeeting,
  recordingId: string,
): Promise<Buffer> {
  assertSafeMeetingId(meeting.id);
  const root = tmpRoot();
  await fs.mkdir(root, { recursive: true });
  // A scratch directory per run, never a path derived from the meeting id alone:
  // two runs of the same meeting must not delete each other's files mid-transcode.
  const dir = await fs.mkdtemp(path.join(root, `${meeting.id}-`));
  const mp4Path = path.join(dir, 'recording.mp4');
  const wavPath = path.join(dir, 'recording.wav');

  try {
    await downloadRecording(userId, meeting.graphMeetingId, recordingId, mp4Path);
    await transcodeToWav(mp4Path, wavPath);
    return await fs.readFile(wavPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

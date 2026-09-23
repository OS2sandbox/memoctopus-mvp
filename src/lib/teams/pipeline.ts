import fs from 'fs/promises';
import path from 'path';
import { runFfmpeg } from '@/lib/audio/decode-server';
import { GraphError, classifyGraphError } from './graph-client';
import { realDate } from './graph-dates';
import { listArtifacts, pickArtifact, downloadTranscriptVtt, downloadRecording } from './artifacts';
import { parseVtt, turnsFromVtt, segmentsFromVtt, speakersFromVtt, type VttCue } from './vtt';
import {
  storePendingTranscript,
  readPendingTranscript,
  readPendingMeta,
  markNoRecording,
  setMeetingOwner,
  type PendingTranscript,
} from '@/lib/pending-artifacts';
import { transcribeRecording } from '@/lib/transcribe-recording';
import { withMeetingLock } from './meeting-lock';
import { artifactMode } from './artifact-mode';

export { artifactMode };

// One meeting's worth of work: ask Graph what artifacts exist, decide which of the
// three processing modes applies, and land the result in the pending stash the
// client already knows how to collect (/api/meetings/[id]/pending-audio + /pending-transcript).
//
// Idempotent: a meeting whose stash is already 'ready' is not reprocessed, and a
// run in flight reports 'pending' rather than starting a second download.

export type ProcessingMode = 'recording+transcript' | 'transcript-only' | 'recording-only';

export type PipelineOutcome =
  | {
      status: 'ready';
      mode: ProcessingMode;
      speakers: string[];
      transcriptId: string | null;
      recordingId: string | null;
    }
  // `transient`: pending because Graph was throttled or unreachable, not because
  // Teams has nothing yet. Such a poll must not count toward RECORDING_GRACE_ATTEMPTS.
  | { status: 'pending'; transient?: true }
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
  return runFfmpeg(
    ['-loglevel', 'error', '-nostdin', '-y', '-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath],
    { context: 'Converting the Teams recording' },
  );
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
      // The stash does not record which mode produced it, so this reports what the
      // current configuration would run. Nothing consumes `mode` beyond logging.
      mode: artifactMode() === 'transcript-only' ? 'transcript-only' : 'recording+transcript',
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
    //
    // A tenant that has switched off Graph access to transcripts also propagates:
    // it is not this meeting's fault and no retry can fix it, so let the poller
    // turn it into the message that names the admin guide instead of leaking
    // Graph's English.
    switch (classifyGraphError(err)) {
      case 'reauth_required':
      case 'transcripts_disabled':
        throw err;
      case 'retryable':
        return { status: 'pending', transient: true };
      case 'graph_error':
        return { status: 'failed', reason: (err as GraphError).message };
      case 'unknown':
        throw err;
    }
  }

  // realDate drops Graph's 0001-01-01 zero value, which an instant meeting has for
  // both ends. Without it the occurrence window sits in the year 1 and matches no
  // artifact; with it the window is simply absent and the newest artifact wins,
  // which is the right answer for a meeting that had no schedule.
  const windowStart = realDate(meeting.scheduledStart);
  const windowEnd = realDate(meeting.scheduledEnd);
  const window = windowStart && windowEnd ? { start: windowStart, end: windowEnd } : undefined;
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
    const cls = classifyGraphError(err);
    if (cls === 'reauth_required' || cls === 'transcripts_disabled') throw err;
    if (cls === 'retryable') return { status: 'pending', transient: true };
    const reason = err instanceof Error ? err.message : 'Ukendt fejl under hentning fra Microsoft Teams';
    console.error(`[teams-pipeline] ${meeting.id} failed:`, err);
    return { status: 'failed', reason };
  }
}

/** True once waiting any longer for Teams to publish the recording is futile. */
function graceElapsed(meeting: PipelineMeeting, now: Date): boolean {
  if ((meeting.attempts ?? 0) >= RECORDING_GRACE_ATTEMPTS) return true;
  // Same sentinel guard: a year-1 end would make the grace look long spent, so a
  // prefer-recording run would settle for the transcript before Teams has had any
  // chance to publish the recording.
  const end = realDate(meeting.scheduledEnd);
  if (!end) return false;
  return now.getTime() >= end.getTime() + RECORDING_GRACE_MS;
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
  let mode: ProcessingMode = 'recording+transcript';
  if (heardNothing(await assertTranscribed(meeting.id))) {
    // Teams' own transcript is already in hand and regularly has words where hviske
    // found none, so prefer it over shipping an empty transcript. Losing hviske's
    // Danish costs quality; shipping nothing costs the meeting.
    const fromTeams = segmentsFromVtt(cues);
    if (fromTeams.length === 0) {
      await storePendingTranscript(meeting.id, { status: 'failed' });
      throw new Error('Hverken optagelsen eller Teams\' transskription indeholdt tale.');
    }
    await storePendingTranscript(meeting.id, {
      status: 'ready',
      segments: fromTeams,
      diarized: true,
    });
    mode = 'transcript-only';
  }

  // After the verdict, so a run that failed transcription never advertises itself
  // as finished-with-no-audio to a client that would then stop waiting.
  await markNoRecording(meeting.id, {
    participants: speakers,
    durationSeconds: durationFromCues(cues),
  });

  return { status: 'ready', mode, speakers, transcriptId, recordingId };
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
  if (heardNothing(await assertTranscribed(meeting.id))) {
    // No Teams transcript in this mode, so there is nothing to fall back to.
    await storePendingTranscript(meeting.id, { status: 'failed' });
    throw new Error('Optagelsen fra Teams indeholdt ingen tale.');
  }
  await markNoRecording(meeting.id, { participants: [], durationSeconds: null });

  return { status: 'ready', mode: 'recording-only', speakers: [], transcriptId: null, recordingId };
}

// transcribeRecording is fail-soft: it records its own failure in the stash rather
// than throwing, so the pipeline has to read the verdict back to know whether the
// meeting is genuinely ready.
async function assertTranscribed(meetingId: string): Promise<PendingTranscript> {
  const stash = await readPendingTranscript(meetingId);
  if (stash?.status !== 'ready') {
    throw new Error('Transskriptionen af optagelsen fra Teams fejlede.');
  }
  return stash;
}

/**
 * hviske can answer `ready` with nothing in it — a near-silent recording, or one
 * too short to get a word out of. Stashed as-is that is indistinguishable, to the
 * browser, from a transcript that is still being written: it stops waiting, finds
 * no segments, and falls back to transcribing local audio, which a Teams meeting
 * never has. The user is then told "Lydfil ikke fundet" about a meeting whose
 * transcript Teams was holding all along.
 */
function heardNothing(stash: PendingTranscript): boolean {
  return (stash.segments?.length ?? 0) === 0;
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

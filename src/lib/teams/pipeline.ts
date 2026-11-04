import fs from 'fs/promises';
import path from 'path';
import { runFfmpeg } from '@/lib/audio/decode-server';
import { GraphError, classifyGraphError } from './graph-client';
import { graphDate, realDate } from './graph-dates';
import {
  listArtifacts,
  pickArtifact,
  selectArtifacts,
  downloadTranscriptVtt,
  downloadRecording,
  type ArtifactRef,
} from './artifacts';
import { parseVtt, segmentsFromVtt, speakersFromVtt, type VttCue } from './vtt';
import {
  storePendingTranscript,
  readPendingTranscript,
  storePendingMeta,
  deletePendingTranscript,
  setMeetingOwner,
  type PendingTranscript,
} from '@/lib/pending-artifacts';
import { transcribeRecording } from '@/lib/transcribe-recording';
import type { TranscriptSegment } from '@/types';
import { transcribeAlongCues } from './transcribe-cues';
import { withMeetingLock } from './meeting-lock';
import { assertSafeMeetingId } from './meeting-id';
import { teamsScratchRoot } from './scratch';
import { artifactMode } from './artifact-mode';
import {
  SAME_START_TOLERANCE_MS,
  artifactSpan,
  joinPieces,
  labelPart,
  leftoverCues,
  placeTranscript,
  startOf,
  takeCuesFor,
  type PlacedTranscript,
  type TimedPiece,
} from './timeline';

// One meeting's worth of work: ask Graph what artifacts exist, decide which of the
// three processing modes applies, and land the result in the pending stash the
// client collects (/api/meetings/[id]/pending-meta + /pending-transcript).
//
// Idempotent: a meeting whose stash is already 'ready' is not reprocessed, and a
// run in flight reports 'pending' rather than starting a second download.

export type ProcessingMode = 'recording+transcript' | 'transcript-only' | 'recording-only';

export type PipelineOutcome =
  | {
      status: 'ready';
      /** Which of the three modes produced the transcript. */
      mode: ProcessingMode;
      transcriptId: string | null;
      recordingId: string | null;
      /**
       * Size of the recording our own transcription was made from — what finds
       * the same file in the organizer's OneDrive to delete it once the user has
       * the transcript (recording-cleanup.ts). Null when no recording was
       * transcribed, or when the run fell back to Teams' own transcript: the
       * recording then stays, for a later run to try again.
       */
      recordingBytes: number | null;
      /**
       * Every recording our own transcription was made from, by size — more than
       * one when recording was stopped and started again. `recordingBytes` is the
       * first of them. Empty when there is nothing of ours to delete.
       */
      recordingSizes: number[];
    }
  // `transient`: pending because Graph was throttled or unreachable, not because
  // Teams has nothing yet. Such a poll must not count toward RECORDING_GRACE_ATTEMPTS.
  //
  // `phase` is what the waiting screen shows. 'waiting' means Teams has published
  // nothing yet; 'working' means this meeting's artifacts are in hand and a run is
  // downloading and transcribing them right now. Reporting the second as the first
  // was why pressing "Tjek nu" during a ten-minute download answered "Teams har ikke
  // frigivet transskriptionen endnu" — true of nothing, and indistinguishable from
  // being stuck.
  //
  // `recordingStalled`: the recording itself timed out or was cut off mid-download.
  // Transient too, but counted apart (see PipelineMeeting.recordingUnreachable):
  // Teams has published it, so waiting for Teams will not help.
  | { status: 'pending'; transient?: true; phase?: 'waiting' | 'working'; recordingStalled?: true }
  | { status: 'failed'; reason: string };

export interface PipelineMeeting {
  id: string;
  graphMeetingId: string;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  /** Poll attempts so far — the escape hatch out of the transcript-only grace. */
  attempts?: number;
  /**
   * We have already deleted this meeting's recording from OneDrive. A later run
   * ("Hent igen") must then not wait for a recording, nor try to download one
   * Graph may still list: Teams' own transcript is all that is left to collect.
   */
  recordingDeleted?: boolean;
  /**
   * The recording's download has stalled too often. Teams' own transcript is then
   * collected as it is, without waiting out the grace for a recording we already
   * have but cannot fetch.
   */
  recordingUnreachable?: boolean;
}

/** Why a meeting with nothing but an unreachable recording failed. */
export const RECORDING_UNREACHABLE_MESSAGE =
  'Optagelsen fra Teams kunne ikke hentes: overførslen fra Microsoft gik i stå gentagne gange.';

/**
 * A recording download that timed out or was cut off. Not a 429 or a 503 — those
 * are Graph saying "not now", which says nothing about this recording.
 */
class RecordingStalled extends GraphError {
  constructor(cause: GraphError) {
    super('unavailable', cause.message, { cause });
  }
}

function isStall(err: unknown): err is GraphError {
  return err instanceof GraphError && err.retryable && err.status === 0;
}

/**
 * Teams publishes the transcript before it has finished processing the
 * recording. In `prefer-recording` we therefore wait this long past the
 * scheduled end before settling for transcript-only, or the deployment silently
 * degrades to mode 2 for most meetings.
 */
export const RECORDING_GRACE_MS = 30 * 60 * 1000;

/** …and the same escape by attempt count, for when there is no time to measure from. */
export const RECORDING_GRACE_ATTEMPTS = 15;

/**
 * A stash stuck in `processing` for longer than this belonged to a run that
 * died (deploy, crash, OOM). Treat it as reprocessable rather than as a
 * permanent "pending" that no later run can ever get past.
 */
export const PROCESSING_STALE_MS = 30 * 60 * 1000;

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
    () => ({ status: 'pending', phase: 'working' }),
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
    return {
      status: 'ready',
      // The stash does not record which mode produced it, so this reports what the
      // current configuration would run.
      mode: artifactMode() === 'transcript-only' ? 'transcript-only' : 'recording+transcript',
      transcriptId: null,
      recordingId: null,
      recordingBytes: null,
      recordingSizes: [],
    };
  }
  if (existing?.status === 'processing') {
    const age = now.getTime() - (existing.createdAt ?? 0);
    if (age < PROCESSING_STALE_MS) return { status: 'pending', phase: 'working' };
    // Older than the timeout: the run that wrote it is gone. Fall through and
    // redo the work rather than leaving the meeting pending forever.
  }

  // Bind the stash to its owner BEFORE anything is written into it. Both
  // hand-off routes (pending-meta, pending-transcript) deny by default when
  // no owner file exists, so without this the meeting's real owner is answered
  // 404 and the hand-off can never complete.
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
  const skipRecording =
    artifactMode() === 'transcript-only'
    || meeting.recordingDeleted === true
    || meeting.recordingUnreachable === true;
  // Every stretch of the meeting, not only the newest: recording that was stopped
  // and started again leaves one artifact per stretch.
  const selected = selectArtifacts(artifacts.transcripts, skipRecording ? [] : artifacts.recordings, window);
  const transcript = selected.transcripts.at(-1) ?? null;
  const recording = selected.recordings.at(-1) ?? null;

  if (!transcript && meeting.recordingUnreachable && pickArtifact(artifacts.recordings, window)) {
    return { status: 'failed', reason: RECORDING_UNREACHABLE_MESSAGE };
  }
  if (!transcript && !recording) return { status: 'pending' };

  // Teams publishes the transcript first and the recording minutes later. Taking
  // the transcript-only branch the moment it appears would permanently lock a
  // prefer-recording deployment out of hviske (the run is idempotent), so hold
  // out for the recording until the grace period is spent — for every
  // transcript that no recording covers yet.
  if (!skipRecording) {
    const waiting = selected.transcripts.some(
      (t) => !coveredByRecording(t, selected.recordings) && !graceElapsed(meeting, t, now),
    );
    if (waiting) return { status: 'pending' };
  }

  await storePendingTranscript(meeting.id, { status: 'processing' });

  try {
    if (selected.transcripts.length > 1 || selected.recordings.length > 1) {
      return await runStretches(userId, meeting, selected.transcripts, selected.recordings);
    }
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
    if (err instanceof RecordingStalled) return { status: 'pending', transient: true, recordingStalled: true };
    if (cls === 'retryable') return { status: 'pending', transient: true };
    const reason = err instanceof Error ? err.message : 'Ukendt fejl under hentning fra Microsoft Teams';
    console.error(`[teams-pipeline] ${meeting.id} failed:`, err);
    return { status: 'failed', reason };
  }
}

/**
 * Does some recording span this transcript? Then it is not waiting for one. With
 * no times to compare, any recording counts — the single-pair case as it always
 * was.
 */
function coveredByRecording(transcript: ArtifactRef, recordings: ArtifactRef[]): boolean {
  if (recordings.length === 0) return false;
  const t = artifactSpan(transcript);
  if (t.start == null) return true;
  const tEnd = t.end ?? t.start;
  return recordings.some((r) => {
    const span = artifactSpan(r);
    if (span.start == null) return true;
    const rEnd = span.end ?? span.start;
    return span.start <= tEnd + SAME_START_TOLERANCE_MS && rEnd >= t.start! - SAME_START_TOLERANCE_MS;
  });
}

/** A Graph timestamp as a Date, or null when it is missing or Graph's year-1 zero. */
function artifactDate(value: string | null | undefined): Date | null {
  const date = graphDate(value);
  return date ? new Date(date) : null;
}

/**
 * True once waiting any longer for Teams to publish the recording is futile.
 *
 * Measured from the later of the booked end and the moment Teams' transcript
 * ended, because the recording follows the transcript, not the booking. A meeting
 * with no window is polled from the moment its link is pasted, and a booked one
 * from its end even when it runs over, so by the time such a meeting is really
 * over the attempt counter can be long past RECORDING_GRACE_ATTEMPTS — and
 * counting attempts then settled for Teams' transcript the instant it appeared,
 * minutes before the recording our own transcription is made from.
 *
 * The attempt count remains the escape only when there is no time to measure from.
 */
function graceElapsed(
  meeting: PipelineMeeting,
  transcript: { createdDateTime: string | null; endDateTime?: string | null },
  now: Date,
): boolean {
  // realDate is the sentinel guard: a year-1 end would make the grace look long
  // spent, and the run would settle for the transcript before Teams had any
  // chance to publish the recording.
  const marks = [
    realDate(meeting.scheduledEnd),
    artifactDate(transcript.endDateTime),
    artifactDate(transcript.createdDateTime),
  ].filter((d): d is Date => d !== null);
  if (marks.length === 0) return (meeting.attempts ?? 0) >= RECORDING_GRACE_ATTEMPTS;
  const from = Math.max(...marks.map((d) => d.getTime()));
  return now.getTime() >= from + RECORDING_GRACE_MS;
}

// Mode 1 — the target: Teams' recording transcribed by hviske (good Danish), with
// the timing and the real speaker display names taken from Teams' own transcript.
//
// The recording is cut along Teams' cues rather than by the generic energy VAD —
// see cue-batches.ts for the measurement behind that. It is then dropped. It is
// deliberately never stashed for the browser: Graph publishes nothing until the
// meeting has ended, so nobody can follow a meeting live here, and a copy of the
// raw audio in IndexedDB would then outlive the transcription it was fetched for
// with no user able to act on it. The only thing handed over is the transcript,
// plus the speaker names and duration that pre-fill Gennemgang.
async function runRecordingWithTranscript(
  userId: string,
  meeting: PipelineMeeting,
  transcriptId: string,
  recordingId: string,
): Promise<PipelineOutcome> {
  const cues = parseVtt(await downloadTranscriptVtt(userId, meeting.graphMeetingId, transcriptId));
  const fromTeams = segmentsFromVtt(cues);
  const { wav, bytes } = await fetchRecordingAsWav(userId, meeting, recordingId);

  let heard: TranscriptSegment[] = [];
  try {
    const result = await transcribeAlongCues(wav, cues);
    heard = result.segments;
    console.log(
      `[teams-pipeline] ${meeting.id}: ${heard.length} segments from ${result.batches} cue slices`
      + ` (${result.emptyBatches} empty), Teams' own transcript has ${fromTeams.length}`,
    );
  } catch (err) {
    // Not fatal while Teams' own transcript is in hand: losing hviske's Danish
    // costs quality, shipping nothing costs the meeting.
    console.error(`[teams-pipeline] ${meeting.id} cue transcription failed:`, err);
  }

  let segments = heard;
  let mode: ProcessingMode = 'recording+transcript';
  if (!coversMeeting(heard, fromTeams)) {
    if (fromTeams.length === 0) {
      await storePendingTranscript(meeting.id, { status: 'failed' });
      throw new Error("Hverken optagelsen eller Teams' transskription indeholdt tale.");
    }
    segments = fromTeams;
    mode = 'transcript-only';
  }

  await storePendingTranscript(meeting.id, { status: 'ready', segments, diarized: true });

  // After the verdict, so a run that failed transcription never advertises itself
  // as finished-with-no-audio to a client that would then stop waiting.
  await storePendingMeta(meeting.id, {
    participants: speakersFromVtt(cues),
    durationSeconds: durationFromCues(cues),
  });

  // The recording is only done with once our own transcription of it is what the
  // user gets. After a fall back to Teams' text it is what a later "Hent igen"
  // needs to try again, so it is not offered up for deletion.
  const ours = mode === 'recording+transcript';
  return {
    status: 'ready',
    mode,
    transcriptId,
    recordingId,
    recordingBytes: ours ? bytes : null,
    recordingSizes: ours ? [bytes] : [],
  };
}

/**
 * Below this share of the words Teams itself heard, hviske's pass is treated as
 * having lost the meeting rather than transcribed it.
 *
 * hviske normally produces MORE words than Teams — that is the whole reason for
 * preferring the recording. Coming back with half of them means the model skipped
 * passages (quiet speech in a 22 kbit/s Teams mixdown is where it happens), and
 * Teams' own transcript, already downloaded, is then the better referat.
 */
export const MIN_COVERAGE_RATIO = 0.5;

function wordCount(segments: TranscriptSegment[]): number {
  return segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
}

/** Did hviske hear enough of the meeting to be worth preferring over Teams? */
export function coversMeeting(heard: TranscriptSegment[], fromTeams: TranscriptSegment[]): boolean {
  if (heard.length === 0) return false;
  const teamsWords = wordCount(fromTeams);
  if (teamsWords === 0) return true; // nothing to compare against — hviske is all there is
  return wordCount(heard) >= MIN_COVERAGE_RATIO * teamsWords;
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

  // The meta record is what tells the client the run has finished; without it
  // pending-meta answers 404 until the client gives up.
  await storePendingMeta(meeting.id, {
    participants: speakersFromVtt(cues),
    durationSeconds: durationFromCues(cues),
  });
  await storePendingTranscript(meeting.id, { status: 'ready', segments, diarized: true });

  return {
    status: 'ready',
    mode: 'transcript-only',
    transcriptId,
    recordingId: null,
    recordingBytes: null,
    recordingSizes: [],
  };
}

// Mode 3 — today's behaviour: hviske plus pyannote's anonymous `Taler N` labels.
async function runRecordingOnly(
  userId: string,
  meeting: PipelineMeeting,
  recordingId: string,
): Promise<PipelineOutcome> {
  const { wav, bytes } = await fetchRecordingAsWav(userId, meeting, recordingId);

  // Transcribed and dropped, as in mode 1 — see the note there.
  await transcribeRecording(meeting.id, wav, 'audio/wav');
  if (heardNothing(await assertTranscribed(meeting.id))) {
    // No Teams transcript in this mode, so there is nothing to fall back to.
    await storePendingTranscript(meeting.id, { status: 'failed' });
    throw new Error('Optagelsen fra Teams indeholdt ingen tale.');
  }
  await storePendingMeta(meeting.id, { participants: [], durationSeconds: null });

  return {
    status: 'ready',
    mode: 'recording-only',
    transcriptId: null,
    recordingId,
    recordingBytes: bytes,
    recordingSizes: [bytes],
  };
}

/** Seconds of 16 kHz mono 16-bit audio in a wav from {@link transcodeToWav}. */
function wavSeconds(wav: Buffer): number {
  return Math.max(0, wav.length - 44) / (16000 * 2);
}

/**
 * One meeting, several stretches: recording (and/or transcription) was stopped
 * and started again, so Graph holds more than one recording or transcript.
 *
 * Every artifact is placed on the meeting's clock by the span Graph reports for
 * it. Each recording is then transcribed like a meeting of its own — along the
 * Teams cues that fall inside it (mode 1), or with diarization when no cue does
 * (mode 3) — and the cues no recording covers are used as Teams wrote them
 * (mode 2). The parts are laid end to end on one transcript.
 *
 * Recordings are fetched one at a time, so only one is ever held in memory.
 */
async function runStretches(
  userId: string,
  meeting: PipelineMeeting,
  transcriptRefs: ArtifactRef[],
  recordingRefs: ArtifactRef[],
): Promise<PipelineOutcome> {
  const placed: PlacedTranscript[] = [];
  const allCues: VttCue[] = [];
  for (const ref of transcriptRefs) {
    const cues = parseVtt(await downloadTranscriptVtt(userId, meeting.graphMeetingId, ref.id));
    const start = startOf(artifactSpan(ref), durationFromCues(cues));
    if (start == null) {
      // Cannot be placed. Its text is still the meeting, so it is not dropped:
      // it goes at the end, after everything that could be placed.
      console.warn(`[teams-pipeline] ${meeting.id}: transcript ${ref.id} has no usable times`);
    }
    placed.push(placeTranscript(start ?? Number.MAX_SAFE_INTEGER, cues));
    allCues.push(...cues);
  }
  const named = new Set(speakersFromVtt(allCues));

  const pieces: TimedPiece[] = [];
  const ourSizes: number[] = [];
  let anonymousParts = 0;
  const modes = new Set<ProcessingMode>();

  for (const [index, ref] of recordingRefs.entries()) {
    const { wav, bytes } = await fetchRecordingAsWav(userId, meeting, ref.id);
    const seconds = wavSeconds(wav);
    const start = startOf(artifactSpan(ref), seconds);
    if (start == null) {
      console.warn(`[teams-pipeline] ${meeting.id}: recording ${ref.id} has no usable times, skipped`);
      continue;
    }
    const cues = takeCuesFor(placed, { start, end: start + seconds * 1000 });

    if (cues.length > 0) {
      const fromTeams = segmentsFromVtt(cues);
      let heard: TranscriptSegment[] = [];
      try {
        heard = (await transcribeAlongCues(wav, cues)).segments;
      } catch (err) {
        console.error(`[teams-pipeline] ${meeting.id} cue transcription of ${ref.id} failed:`, err);
      }
      if (coversMeeting(heard, fromTeams)) {
        pieces.push({ start, segments: heard });
        ourSizes.push(bytes);
        modes.add('recording+transcript');
      } else {
        // Teams' text for this stretch, and the recording is kept for a re-run.
        pieces.push({ start, segments: fromTeams });
        modes.add('transcript-only');
      }
      continue;
    }

    // No cue inside this recording: diarize it, under a scratch id nobody can
    // collect, so the meeting's own stash never holds just one stretch.
    const scratchId = `${meeting.id}-del${index + 1}`;
    try {
      await transcribeRecording(scratchId, wav, 'audio/wav');
      const stash = await readPendingTranscript(scratchId);
      const segments = stash?.status === 'ready' ? stash.segments ?? [] : [];
      if (segments.length > 0) {
        anonymousParts += 1;
        pieces.push({ start, segments: labelPart(segments, anonymousParts, named) });
        ourSizes.push(bytes);
        modes.add('recording-only');
      }
    } finally {
      await deletePendingTranscript(scratchId).catch(() => {});
    }
  }

  // What Teams transcribed while nothing was being recorded.
  for (const t of placed) {
    const rest = leftoverCues(t);
    if (rest.length === 0) continue;
    pieces.push({ start: t.start, segments: segmentsFromVtt(rest) });
    modes.add('transcript-only');
  }

  const { segments, durationSeconds } = joinPieces(pieces);
  if (segments.length === 0) {
    await storePendingTranscript(meeting.id, { status: 'failed' });
    throw new Error("Hverken optagelserne eller Teams' transskriptioner fra mødet indeholdt tale.");
  }

  await storePendingTranscript(meeting.id, { status: 'ready', segments, diarized: true });
  await storePendingMeta(meeting.id, { participants: speakersFromVtt(allCues), durationSeconds });

  // The mode only reaches the logs; name the best that went into the transcript.
  const mode: ProcessingMode = modes.has('recording+transcript')
    ? 'recording+transcript'
    : modes.has('recording-only') ? 'recording-only' : 'transcript-only';
  console.log(
    `[teams-pipeline] ${meeting.id}: ${recordingRefs.length} recordings and ${transcriptRefs.length}`
    + ` transcripts joined into ${segments.length} segments (${[...modes].join(', ')})`,
  );
  return {
    status: 'ready',
    mode,
    transcriptId: transcriptRefs.at(-1)?.id ?? null,
    recordingId: recordingRefs.at(-1)?.id ?? null,
    recordingBytes: ourSizes[0] ?? null,
    recordingSizes: ourSizes,
  };
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
): Promise<{ wav: Buffer; bytes: number }> {
  assertSafeMeetingId(meeting.id);
  const root = teamsScratchRoot();
  await fs.mkdir(root, { recursive: true });
  // A scratch directory per run, never a path derived from the meeting id alone:
  // two runs of the same meeting must not delete each other's files mid-transcode.
  const dir = await fs.mkdtemp(path.join(root, `${meeting.id}-`));
  const mp4Path = path.join(dir, 'recording.mp4');
  const wavPath = path.join(dir, 'recording.wav');

  try {
    const { bytes } = await downloadRecording(userId, meeting.graphMeetingId, recordingId, mp4Path).catch(
      (err: unknown) => {
        throw isStall(err) ? new RecordingStalled(err) : err;
      },
    );
    await transcodeToWav(mp4Path, wavPath);
    return { wav: await fs.readFile(wavPath), bytes };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

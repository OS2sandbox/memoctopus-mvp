import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const mockListArtifacts = vi.hoisted(() => vi.fn());
const mockDownloadVtt = vi.hoisted(() => vi.fn());
const mockDownloadRecording = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockStorePendingAudio = vi.hoisted(() => vi.fn());
const mockStorePendingTranscript = vi.hoisted(() => vi.fn());
const mockReadPendingTranscript = vi.hoisted(() => vi.fn());
const mockReadPendingMeta = vi.hoisted(() => vi.fn());
const mockMarkNoRecording = vi.hoisted(() => vi.fn());
const mockTranscribeRecording = vi.hoisted(() => vi.fn());
const mockSetOwner = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockMkdtemp = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());

vi.mock('./artifacts', async () => {
  const actual = await vi.importActual<typeof import('./artifacts')>('./artifacts');
  return {
    pickArtifact: actual.pickArtifact,
    listArtifacts: mockListArtifacts,
    downloadTranscriptVtt: mockDownloadVtt,
    downloadRecording: mockDownloadRecording,
  };
});

vi.mock('child_process', () => ({ spawn: mockSpawn }));

vi.mock('fs/promises', () => ({
  default: { mkdir: mockMkdir, mkdtemp: mockMkdtemp, readFile: mockReadFile, rm: mockRm },
}));

// The advisory lock needs a real Postgres; the behaviour it guards is covered in
// meeting-lock.test.ts. Here it is a pass-through.
vi.mock('./meeting-lock', () => ({
  withMeetingLock: <T,>(_key: string, fn: () => Promise<T>) => fn(),
}));

vi.mock('@/lib/pending-artifacts', () => ({
  storePendingAudio: mockStorePendingAudio,
  storePendingTranscript: mockStorePendingTranscript,
  readPendingTranscript: mockReadPendingTranscript,
  readPendingMeta: mockReadPendingMeta,
  markNoRecording: mockMarkNoRecording,
  setMeetingOwner: mockSetOwner,
}));

vi.mock('@/lib/transcribe-recording', () => ({ transcribeRecording: mockTranscribeRecording }));

import { GraphError } from './graph-client';
import { artifactMode, processTeamsMeeting, transcodeToWav } from './pipeline';

const VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:04.000',
  '<v Mette Hansen>Velkommen til mødet.</v>',
  '',
  '00:00:04.500 --> 00:00:09.250',
  '<v Jens Poulsen>Tak, lad os komme i gang.</v>',
  '',
].join('\n');

/** Past the recording grace period, so transcript-only is allowed to settle. */
const AFTER_GRACE = new Date('2026-09-08T12:00:00Z');

/** Inside the grace period: Teams may still be processing the recording. */
const JUST_AFTER_END = new Date('2026-09-08T11:05:00Z');

const SCRATCH = '/data/audio/teams-tmp/meet-1-abc123';

const MEETING = {
  id: 'meet-1',
  graphMeetingId: 'MSpiZGE=',
  scheduledStart: new Date('2026-09-08T10:00:00Z'),
  scheduledEnd: new Date('2026-09-08T11:00:00Z'),
};

const TRANSCRIPT_REF = { id: 't1', createdDateTime: '2026-09-08T11:05:00Z', endDateTime: null };
const RECORDING_REF = { id: 'r1', createdDateTime: '2026-09-08T11:07:00Z', endDateTime: null };

/** A fake ffmpeg child process that exits with the given code on the next tick. */
function fakeFfmpeg(code: number, stderr = '') {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  child.stderr = new EventEmitter();
  setTimeout(() => {
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  }, 0);
  return child;
}

const WAV = Buffer.from('wav-bytes');

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.TEAMS_ARTIFACT_MODE;
  process.env.AUDIO_STORAGE_PATH = '/data/audio';

  mockListArtifacts.mockReset().mockResolvedValue({ transcripts: [], recordings: [] });
  mockDownloadVtt.mockReset().mockResolvedValue(VTT);
  mockDownloadRecording.mockReset().mockResolvedValue({ bytes: 1234 });
  mockSpawn.mockReset().mockImplementation(() => fakeFfmpeg(0));
  mockStorePendingAudio.mockReset().mockResolvedValue(undefined);
  mockStorePendingTranscript.mockReset().mockResolvedValue(undefined);
  mockReadPendingTranscript.mockReset().mockResolvedValue(null);
  mockReadPendingMeta.mockReset().mockResolvedValue(null);
  mockMarkNoRecording.mockReset().mockResolvedValue(undefined);
  mockMkdir.mockReset().mockResolvedValue(undefined);
  mockMkdtemp.mockReset().mockImplementation(async (prefix: string) => `${prefix}abc123`);
  mockSetOwner.mockReset().mockResolvedValue(undefined);
  mockReadFile.mockReset().mockResolvedValue(WAV);
  mockRm.mockReset().mockResolvedValue(undefined);
  // transcribeRecording is fail-soft; by default it succeeds and leaves a ready stash.
  mockTranscribeRecording.mockReset().mockImplementation(async () => {
    mockReadPendingTranscript.mockResolvedValue({ status: 'ready', segments: [], createdAt: 1 });
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.TEAMS_ARTIFACT_MODE;
  delete process.env.AUDIO_STORAGE_PATH;
});

describe('artifactMode', () => {
  it('defaults to prefer-recording', () => {
    expect(artifactMode()).toBe('prefer-recording');
  });

  it('honours TEAMS_ARTIFACT_MODE=transcript-only, whitespace and case included', () => {
    process.env.TEAMS_ARTIFACT_MODE = '  Transcript-Only ';
    expect(artifactMode()).toBe('transcript-only');
  });

  it('falls back to prefer-recording for an empty or unknown value', () => {
    process.env.TEAMS_ARTIFACT_MODE = '   ';
    expect(artifactMode()).toBe('prefer-recording');
    process.env.TEAMS_ARTIFACT_MODE = 'nonsense';
    expect(artifactMode()).toBe('prefer-recording');
  });
});

describe('processTeamsMeeting — nothing yet', () => {
  it('is pending when Graph has neither transcript nor recording', async () => {
    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);
    expect(outcome).toEqual({ status: 'pending' });
    expect(mockStorePendingTranscript).not.toHaveBeenCalled();
  });

  it('is pending when the artifacts fall outside this occurrence of a series', async () => {
    mockListArtifacts.mockResolvedValue({
      transcripts: [{ id: 't-old', createdDateTime: '2026-09-01T11:05:00Z', endDateTime: null }],
      recordings: [],
    });
    expect(await processTeamsMeeting('u1', MEETING, AFTER_GRACE)).toEqual({ status: 'pending' });
  });
});

describe('processTeamsMeeting — recording + transcript', () => {
  beforeEach(() => {
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [RECORDING_REF] });
  });

  it('downloads both, transcodes to wav and injects the VTT speaker turns', async () => {
    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);

    expect(outcome).toEqual({
      status: 'ready',
      mode: 'recording+transcript',
      speakers: ['Mette Hansen', 'Jens Poulsen'],
      transcriptId: 't1',
      recordingId: 'r1',
    });

    // mp4 lands under AUDIO_STORAGE_PATH, never in the repo.
    expect(mockDownloadRecording).toHaveBeenCalledWith('u1', MEETING.graphMeetingId, 'r1', `${SCRATCH}/recording.mp4`);
    expect(mockMkdir).toHaveBeenCalledWith('/data/audio/teams-tmp', { recursive: true });

    const ffArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(mockSpawn.mock.calls[0][0]).toBe('ffmpeg');
    expect(ffArgs).toEqual(expect.arrayContaining(['-ar', '16000', '-ac', '1', `${SCRATCH}/recording.wav`]));

    // The stash carries the real names and the VTT duration, and no audio: a Graph
    // meeting cannot be followed live, so the raw recording is transcribed and
    // dropped rather than handed to the browser.
    expect(mockStorePendingAudio).not.toHaveBeenCalled();
    expect(mockMarkNoRecording).toHaveBeenCalledWith('meet-1', {
      participants: ['Mette Hansen', 'Jens Poulsen'],
      durationSeconds: 9,
    });

    const [id, buffer, mime, opts] = mockTranscribeRecording.mock.calls[0];
    expect(id).toBe('meet-1');
    expect(buffer).toBe(WAV);
    expect(mime).toBe('audio/wav');
    expect(opts.preserveNames).toBe(true);
    expect(opts.turns.map((t: { speaker: string }) => t.speaker)).toEqual(['Mette Hansen', 'Jens Poulsen']);
  });

  it('marks the run in flight so a concurrent poll does not start a second download', async () => {
    await processTeamsMeeting('u1', MEETING, AFTER_GRACE);
    expect(mockStorePendingTranscript).toHaveBeenCalledWith('meet-1', { status: 'processing' });
  });

  it('cleans up both temp files even when the download fails', async () => {
    mockDownloadRecording.mockRejectedValue(new Error('netværket forsvandt'));

    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);

    expect(outcome).toEqual({ status: 'failed', reason: 'netværket forsvandt' });
    expect(mockRm).toHaveBeenCalledWith(SCRATCH, { recursive: true, force: true });
    expect(mockStorePendingTranscript).toHaveBeenLastCalledWith('meet-1', { status: 'failed' });
  });

  it('cleans up and fails when ffmpeg exits non-zero', async () => {
    mockSpawn.mockImplementation(() => fakeFfmpeg(1, 'moov atom not found'));

    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);

    expect(outcome.status).toBe('failed');
    expect((outcome as { reason: string }).reason).toContain('moov atom not found');
    expect(mockRm).toHaveBeenCalledWith(SCRATCH, { recursive: true, force: true });
    expect(mockTranscribeRecording).not.toHaveBeenCalled();
  });

  it('fails when the fail-soft transcription left a failed stash', async () => {
    mockTranscribeRecording.mockImplementation(async () => {
      mockReadPendingTranscript.mockResolvedValue({ status: 'failed', createdAt: 1 });
    });

    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);
    expect(outcome.status).toBe('failed');
  });

  it('uses the newest artifacts overall when the meeting has no schedule', async () => {
    mockListArtifacts.mockResolvedValue({
      transcripts: [
        { id: 't-old', createdDateTime: '2026-01-01T00:00:00Z', endDateTime: null },
        TRANSCRIPT_REF,
      ],
      recordings: [RECORDING_REF],
    });

    const outcome = await processTeamsMeeting('u1', { ...MEETING, scheduledStart: null, scheduledEnd: null }, AFTER_GRACE);
    expect(outcome).toMatchObject({ status: 'ready', transcriptId: 't1' });
  });
});

describe('processTeamsMeeting — transcript only', () => {
  it('uses the VTT text directly when Teams has no recording', async () => {
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [] });

    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);

    expect(outcome).toEqual({
      status: 'ready',
      mode: 'transcript-only',
      speakers: ['Mette Hansen', 'Jens Poulsen'],
      transcriptId: 't1',
      recordingId: null,
    });
    expect(mockDownloadRecording).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    // The audio route needs a meta record or the client polls 404 forever — and
    // it carries the VTT speaker names, which pre-fill participants in Gennemgang.
    expect(mockMarkNoRecording).toHaveBeenCalledWith('meet-1', {
      participants: ['Mette Hansen', 'Jens Poulsen'],
      durationSeconds: 9,
    });
    const [, stash] = mockStorePendingTranscript.mock.calls.at(-1)!;
    expect(stash.status).toBe('ready');
    expect(stash.diarized).toBe(true);
    expect(stash.segments.map((s: { speaker: string; text: string }) => [s.speaker, s.text])).toEqual([
      ['Mette Hansen', 'Velkommen til mødet.'],
      ['Jens Poulsen', 'Tak, lad os komme i gang.'],
    ]);
  });

  it('waits for the recording before settling for transcript-only', async () => {
    // Teams publishes the transcript first. Falling back the moment it appears
    // would permanently degrade a prefer-recording deployment to mode 2, because
    // the run is idempotent and never redone.
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [] });

    expect(await processTeamsMeeting('u1', MEETING, JUST_AFTER_END)).toEqual({ status: 'pending' });
    expect(mockDownloadVtt).not.toHaveBeenCalled();
    expect(mockStorePendingTranscript).not.toHaveBeenCalled();
  });

  it('gives up on the recording once enough attempts have been spent', async () => {
    // A meeting with no schedule has no grace deadline; the attempt count is the
    // only escape from waiting forever.
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [] });
    const noSchedule = { ...MEETING, scheduledStart: null, scheduledEnd: null };

    expect(await processTeamsMeeting('u1', noSchedule, JUST_AFTER_END)).toEqual({ status: 'pending' });
    expect(
      await processTeamsMeeting('u1', { ...noSchedule, attempts: 15 }, JUST_AFTER_END),
    ).toMatchObject({ status: 'ready', mode: 'transcript-only' });
  });

  it('does not wait for a recording it will never fetch in transcript-only mode', async () => {
    process.env.TEAMS_ARTIFACT_MODE = 'transcript-only';
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [] });

    expect(await processTeamsMeeting('u1', MEETING, JUST_AFTER_END)).toMatchObject({
      status: 'ready',
      mode: 'transcript-only',
    });
  });

  it('ignores the recording entirely when TEAMS_ARTIFACT_MODE=transcript-only', async () => {
    process.env.TEAMS_ARTIFACT_MODE = 'transcript-only';
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [RECORDING_REF] });

    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);

    expect(outcome).toMatchObject({ status: 'ready', mode: 'transcript-only' });
    expect(mockDownloadRecording).not.toHaveBeenCalled();
    expect(mockTranscribeRecording).not.toHaveBeenCalled();
  });

  it('is pending in transcript-only mode when only a recording exists', async () => {
    process.env.TEAMS_ARTIFACT_MODE = 'transcript-only';
    mockListArtifacts.mockResolvedValue({ transcripts: [], recordings: [RECORDING_REF] });

    expect(await processTeamsMeeting('u1', MEETING, AFTER_GRACE)).toEqual({ status: 'pending' });
  });

  it('fails when the transcript contains no cues', async () => {
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [] });
    mockDownloadVtt.mockResolvedValue('WEBVTT\n\n');

    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);
    expect(outcome).toEqual({ status: 'failed', reason: 'Transskriptionen fra Teams var tom.' });
    expect(mockStorePendingTranscript).toHaveBeenLastCalledWith('meet-1', { status: 'failed' });
  });
});

describe('processTeamsMeeting — recording only', () => {
  it('falls back to hviske + pyannote when Teams transcribed nothing', async () => {
    mockListArtifacts.mockResolvedValue({ transcripts: [], recordings: [RECORDING_REF] });

    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);

    expect(outcome).toEqual({
      status: 'ready',
      mode: 'recording-only',
      speakers: [],
      transcriptId: null,
      recordingId: 'r1',
    });
    expect(mockDownloadVtt).not.toHaveBeenCalled();
    // No turns injected — transcribe-recording runs its own diarization pass.
    expect(mockTranscribeRecording).toHaveBeenCalledWith('meet-1', WAV, 'audio/wav');
    expect(mockStorePendingAudio).not.toHaveBeenCalled();
    expect(mockMarkNoRecording).toHaveBeenCalledWith('meet-1', {
      participants: [],
      durationSeconds: null,
    });
  });
});

// The product requirement behind this: Graph publishes nothing until a meeting has
// ended, so a Teams meeting can never be followed live here. Raw meeting audio is
// therefore transcribed server-side and dropped, never stashed for a browser to
// keep. Asserted per mode rather than once, so adding a fourth mode that stashes
// audio fails here instead of shipping.
describe('processTeamsMeeting — no mode hands raw audio to the browser', () => {
  it('recording+transcript stashes no audio', async () => {
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [RECORDING_REF] });
    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);
    expect(outcome).toMatchObject({ status: 'ready', mode: 'recording+transcript' });
    expect(mockStorePendingAudio).not.toHaveBeenCalled();
  });

  it('recording-only stashes no audio', async () => {
    mockListArtifacts.mockResolvedValue({ transcripts: [], recordings: [RECORDING_REF] });
    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);
    expect(outcome).toMatchObject({ status: 'ready', mode: 'recording-only' });
    expect(mockStorePendingAudio).not.toHaveBeenCalled();
  });

  it('transcript-only stashes no audio', async () => {
    process.env.TEAMS_ARTIFACT_MODE = 'transcript-only';
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [RECORDING_REF] });
    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);
    expect(outcome).toMatchObject({ status: 'ready', mode: 'transcript-only' });
    expect(mockStorePendingAudio).not.toHaveBeenCalled();
  });

  // The transcript is what the browser gets instead, so the meeting still reaches
  // Gennemgang with its speaker names.
  it('still hands over the transcript and the speaker names', async () => {
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [RECORDING_REF] });
    await processTeamsMeeting('u1', MEETING, AFTER_GRACE);
    expect(mockMarkNoRecording).toHaveBeenCalledWith('meet-1', {
      participants: ['Mette Hansen', 'Jens Poulsen'],
      durationSeconds: 9,
    });
  });

  // Ordering matters: a run whose transcription failed must not leave behind a
  // "finished, no audio" marker, or the client stops waiting on a failed meeting.
  it('does not mark no-recording when transcription fails', async () => {
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [RECORDING_REF] });
    // transcribeRecording is fail-soft: it records the verdict in the stash rather
    // than throwing, which is what assertTranscribed reads back.
    mockTranscribeRecording.mockImplementation(async () => {
      mockReadPendingTranscript.mockResolvedValue({ status: 'failed', createdAt: 1 });
    });

    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(mockMarkNoRecording).not.toHaveBeenCalled();
  });
});

describe('processTeamsMeeting — idempotency and errors', () => {
  it('does not reprocess a meeting whose stash is already ready', async () => {
    mockReadPendingTranscript.mockResolvedValue({ status: 'ready', segments: [], createdAt: 1 });
    mockReadPendingMeta.mockResolvedValue({
      hasRecording: true, participants: ['Mette Hansen'], mimeType: 'audio/wav', durationSeconds: 9, createdAt: 1,
    });

    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);

    expect(outcome).toMatchObject({ status: 'ready', mode: 'recording+transcript', speakers: ['Mette Hansen'] });
    expect(mockListArtifacts).not.toHaveBeenCalled();
    expect(mockDownloadRecording).not.toHaveBeenCalled();
  });

  it('reports pending while another run is in flight', async () => {
    mockReadPendingTranscript.mockResolvedValue({
      status: 'processing',
      createdAt: AFTER_GRACE.getTime() - 60_000,
    });
    expect(await processTeamsMeeting('u1', MEETING, AFTER_GRACE)).toEqual({ status: 'pending' });
    expect(mockListArtifacts).not.toHaveBeenCalled();
  });

  it('reprocesses a stash left "processing" by a run that died', async () => {
    // A deploy or a crash mid-download leaves the marker behind; without a
    // timeout every later run would answer pending forever.
    mockReadPendingTranscript.mockResolvedValue({
      status: 'processing',
      createdAt: AFTER_GRACE.getTime() - 31 * 60_000,
    });
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [] });

    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);
    expect(outcome).toMatchObject({ status: 'ready', mode: 'transcript-only' });
  });

  it('binds the stash to its owner before writing anything into it', async () => {
    // Both hand-off routes deny by default when no owner file exists, so without
    // this the meeting's real owner is answered 404 / { status: 'none' }.
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [] });

    await processTeamsMeeting('u1', MEETING, AFTER_GRACE);

    expect(mockSetOwner).toHaveBeenCalledWith('meet-1', 'u1');
    const ownerOrder = mockSetOwner.mock.invocationCallOrder[0];
    expect(ownerOrder).toBeLessThan(mockStorePendingTranscript.mock.invocationCallOrder[0]);
    expect(ownerOrder).toBeLessThan(mockMarkNoRecording.mock.invocationCallOrder[0]);
  });

  it('binds the owner for the recording modes too', async () => {
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [RECORDING_REF] });
    await processTeamsMeeting('u1', MEETING, AFTER_GRACE);
    expect(mockSetOwner).toHaveBeenCalledWith('meet-1', 'u1');
    expect(mockSetOwner.mock.invocationCallOrder[0])
      .toBeLessThan(mockMarkNoRecording.mock.invocationCallOrder[0]);
  });

  it('rejects a meeting id that would escape the stash directory', async () => {
    await expect(
      processTeamsMeeting('u1', { ...MEETING, id: '../../etc/passwd' }, AFTER_GRACE),
    ).rejects.toThrow(/Invalid meetingId/);
    expect(mockListArtifacts).not.toHaveBeenCalled();
    expect(mockSetOwner).not.toHaveBeenCalled();
  });

  it('is pending — not failed — for a throttled or unavailable Graph', async () => {
    // Graph throttles /transcripts routinely; one 429 must not cost the referat.
    for (const status of [429, 503, 500, 408]) {
      mockListArtifacts.mockRejectedValue(
        new GraphError('unavailable', `Microsoft Graph svarede ${status}`, { status }),
      );
      // `transient` is what tells the poller this poll must not spend a grace attempt.
      expect(await processTeamsMeeting('u1', MEETING, AFTER_GRACE)).toEqual({
        status: 'pending',
        transient: true,
      });
    }
  });

  it('is pending and transient for a timeout while downloading, too', async () => {
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [] });
    mockDownloadVtt.mockRejectedValue(new GraphError('unavailable', 'Microsoft svarede ikke i tide.'));
    expect(await processTeamsMeeting('u1', MEETING, AFTER_GRACE)).toEqual({
      status: 'pending',
      transient: true,
    });
  });

  it('still fails for a non-retryable Graph error', async () => {
    mockListArtifacts.mockRejectedValue(new GraphError('forbidden', 'ingen adgang', { status: 403 }));
    expect(await processTeamsMeeting('u1', MEETING, AFTER_GRACE)).toEqual({
      status: 'failed',
      reason: 'ingen adgang',
    });
  });

  it('retries a previously failed run', async () => {
    mockReadPendingTranscript.mockResolvedValue({ status: 'failed', createdAt: 1 });
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [] });

    const outcome = await processTeamsMeeting('u1', MEETING, AFTER_GRACE);
    expect(outcome).toMatchObject({ status: 'ready', mode: 'transcript-only' });
  });

  // GraphAccessToTranscriptsDisabled is a tenant-wide switch, not this meeting's
  // problem, and only an admin can clear it. Swallowing it here would store
  // graph-client's message — which misreads it as per-meeting and carries Graph's
  // English text — instead of the poller's TRANSCRIPTS_DISABLED_MESSAGE, which
  // names the admin guide. So it must propagate.
  it('propagates a transcripts_disabled 403 so the poller can name the admin guide', async () => {
    mockListArtifacts.mockRejectedValue(
      new GraphError('transcripts_disabled', 'Transskription er ikke slået til for dette møde', { status: 403 }),
    );

    await expect(processTeamsMeeting('u1', MEETING, AFTER_GRACE)).rejects.toMatchObject({
      code: 'transcripts_disabled',
    });
  });

  // The VTT download runs before fetchRecordingAsWav, so no scratch dir exists to
  // clean up here — unlike the reauth_required-mid-download case below.
  it('propagates transcripts_disabled raised after the artifact list', async () => {
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [RECORDING_REF] });
    mockDownloadVtt.mockRejectedValue(new GraphError('transcripts_disabled', 'slået fra', { status: 403 }));

    await expect(processTeamsMeeting('u1', MEETING, AFTER_GRACE)).rejects.toMatchObject({
      code: 'transcripts_disabled',
    });
    expect(mockStorePendingTranscript).toHaveBeenCalledWith(MEETING.id, { status: 'failed' });
  });

  it('propagates a reauth_required error so the poller can flag the account', async () => {
    mockListArtifacts.mockRejectedValue(new GraphError('reauth_required', 'token er udløbet', { status: 401 }));
    await expect(processTeamsMeeting('u1', MEETING, AFTER_GRACE)).rejects.toMatchObject({ code: 'reauth_required' });
  });

  it('propagates reauth_required raised mid-download and still cleans up', async () => {
    mockListArtifacts.mockResolvedValue({ transcripts: [TRANSCRIPT_REF], recordings: [RECORDING_REF] });
    mockDownloadRecording.mockRejectedValue(new GraphError('reauth_required', 'væk', { status: 401 }));

    await expect(processTeamsMeeting('u1', MEETING, AFTER_GRACE)).rejects.toMatchObject({ code: 'reauth_required' });
    expect(mockRm).toHaveBeenCalledWith(SCRATCH, { recursive: true, force: true });
  });
});

describe('transcodeToWav', () => {
  it('resolves when ffmpeg exits 0', async () => {
    mockSpawn.mockImplementation(() => fakeFfmpeg(0));
    await expect(transcodeToWav('/in.mp4', '/out.wav')).resolves.toBeUndefined();
  });

  it('explains a missing ffmpeg binary', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      setTimeout(() => child.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })), 0);
      return child;
    });
    await expect(transcodeToWav('/in.mp4', '/out.wav')).rejects.toThrow(/ffmpeg not found on PATH/);
  });
});

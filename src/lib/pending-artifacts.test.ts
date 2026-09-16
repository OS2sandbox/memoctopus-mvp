import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';

// Mock fs/promises so no real disk I/O happens.
vi.mock('fs/promises');

import {
  markNoRecording,
  readPendingMeta,
  readPendingTranscript,
  storePendingTranscript,
  setMeetingOwner,
  getMeetingOwner,
  assertMeetingOwner,
} from './pending-artifacts';

// ─── readPendingMeta ──────────────────────────────────────────────────────────

describe('readPendingMeta', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null and does NOT log when the file does not exist (ENOENT)', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(fs.readFile).mockRejectedValueOnce(enoent);

    const result = await readPendingMeta('meeting-123');

    expect(result).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('returns null AND logs console.error for a non-ENOENT error (e.g. EACCES)', async () => {
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    vi.mocked(fs.readFile).mockRejectedValueOnce(eacces);

    const result = await readPendingMeta('meeting-456');

    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledOnce();
    const [label, id, err] = (console.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(label).toContain('[pending-artifacts]');
    expect(label).toContain('readPendingMeta');
    expect(id).toBe('meeting-456');
    expect(err).toBe(eacces);
  });

  it('returns null AND logs console.error when the file contains invalid JSON (SyntaxError)', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from('not-valid-json'));

    const result = await readPendingMeta('meeting-789');

    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledOnce();
    const [label, id, err] = (console.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(label).toContain('[pending-artifacts]');
    expect(id).toBe('meeting-789');
    expect(err).toBeInstanceOf(SyntaxError);
  });

  it('returns the parsed meta when the file is valid', async () => {
    const meta = {
      participants: ['Alice'],
      durationSeconds: 120,
      createdAt: 1_000_000,
    };
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify(meta)));

    const result = await readPendingMeta('meeting-ok');

    expect(result).toEqual(meta);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('throws for an invalid meetingId (assertSafeId)', async () => {
    await expect(readPendingMeta('../../etc/passwd')).rejects.toThrow('Invalid meetingId');
  });
});

// ─── readPendingTranscript ────────────────────────────────────────────────────

describe('readPendingTranscript', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null and does NOT log for ENOENT', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(fs.readFile).mockRejectedValueOnce(enoent);

    const result = await readPendingTranscript('meeting-123');

    expect(result).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('returns null AND logs for EACCES', async () => {
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    vi.mocked(fs.readFile).mockRejectedValueOnce(eacces);

    const result = await readPendingTranscript('meeting-456');

    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledOnce();
    const [label, id, err] = (console.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(label).toContain('[pending-artifacts]');
    expect(label).toContain('readPendingTranscript');
    expect(id).toBe('meeting-456');
    expect(err).toBe(eacces);
  });

  it('returns null AND logs for invalid JSON', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from('{bad json'));

    const result = await readPendingTranscript('meeting-789');

    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('returns parsed transcript when the file is valid', async () => {
    const transcript = {
      status: 'ready' as const,
      segments: [],
      diarized: true,
      createdAt: 2_000_000,
    };
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify(transcript)));

    const result = await readPendingTranscript('meeting-ok');

    expect(result).toEqual(transcript);
    expect(console.error).not.toHaveBeenCalled();
  });
});

// ─── meeting ownership (cross-user isolation) ──────────────────────────────────

describe('bot meeting ownership', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('setMeetingOwner writes the userId for the meeting', async () => {
    await setMeetingOwner('m1', 'user-A');
    const [, payload] = vi.mocked(fs.writeFile).mock.calls.at(-1)!;
    expect(JSON.parse(payload as string)).toMatchObject({ userId: 'user-A' });
  });

  it('getMeetingOwner returns the stored userId', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify({ userId: 'user-A', createdAt: 1 }));
    expect(await getMeetingOwner('m1')).toBe('user-A');
  });

  it('getMeetingOwner returns null (no log) when unbound (ENOENT)', async () => {
    vi.mocked(fs.readFile).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await getMeetingOwner('m1')).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('assertMeetingOwner is true only for the owning user', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ userId: 'user-A', createdAt: 1 }));
    expect(await assertMeetingOwner('m1', 'user-A')).toBe(true);
    expect(await assertMeetingOwner('m1', 'user-B')).toBe(false);
  });

  it('assertMeetingOwner denies by default when the meeting is unbound', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await assertMeetingOwner('m1', 'user-A')).toBe(false);
  });

  it('rejects an unsafe meetingId (path traversal)', async () => {
    await expect(getMeetingOwner('../etc/passwd')).rejects.toThrow(/Invalid meetingId/);
  });
});

// ─── markNoRecording ──────────────────────────────────────────────────────────

describe('markNoRecording', () => {
  beforeEach(() => {
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes an empty meta by default', async () => {
    await markNoRecording('m1');
    const [, payload] = vi.mocked(fs.writeFile).mock.calls.at(-1)!;
    expect(JSON.parse(payload as string)).toMatchObject({
      participants: [],
      durationSeconds: null,
    });
  });

  it('keeps the speaker names of a transcript-only meeting', async () => {
    // No mode stashes audio, but Teams' transcript still names every speaker, and
    // that is what pre-fills the participant list in Gennemgang.
    await markNoRecording('m1', {
      participants: ['Mette Hansen', 'Jens Poulsen'],
      durationSeconds: 540,
    });

    const [, payload] = vi.mocked(fs.writeFile).mock.calls.at(-1)!;
    expect(JSON.parse(payload as string)).toMatchObject({
      participants: ['Mette Hansen', 'Jens Poulsen'],
      durationSeconds: 540,
    });
  });
});

// ─── TTL sweep ────────────────────────────────────────────────────────────────

// The sweep hangs off storePendingTranscript, which every run reaches — including
// one that ends in 'failed'. It used to hang off storePendingAudio, which no run
// calls any more, and which the removed bot's failed runs never called either,
// so nothing ever cleaned up after them.
describe('the TTL sweep on storePendingTranscript', () => {
  const HOUR = 60 * 60 * 1000;

  function stashContaining(files: Record<string, number>) {
    vi.mocked(fs.readdir).mockResolvedValue(Object.keys(files) as never);
    vi.mocked(fs.readFile).mockImplementation(async (p) => {
      const name = String(p).split('/').pop()!;
      return Buffer.from(JSON.stringify({ createdAt: files[name] })) as never;
    });
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined as never);
    vi.mocked(fs.unlink).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deletes an entry the client never collected', async () => {
    stashContaining({ 'stale.owner.json': Date.now() - 2 * HOUR });
    await storePendingTranscript('current', { status: 'processing' });

    const unlinked = vi.mocked(fs.unlink).mock.calls.map(([p]) => String(p));
    expect(unlinked.some((p) => p.includes('stale'))).toBe(true);
  });

  it('leaves an entry that is still inside the TTL', async () => {
    stashContaining({ 'fresh.owner.json': Date.now() - 60_000 });
    await storePendingTranscript('current', { status: 'processing' });

    const unlinked = vi.mocked(fs.unlink).mock.calls.map(([p]) => String(p));
    expect(unlinked.some((p) => p.includes('fresh'))).toBe(false);
  });

  // The owner file is written once at the start of a run, while the download,
  // transcode and ASR that follow can outlast the TTL on a long meeting. Sweeping
  // blind would delete the owner file of the run in progress, and because the
  // hand-off routes deny by default without one, a successful transcription would
  // become uncollectable and the meeting would never finish.
  it('never sweeps the meeting it is currently writing, however old its owner file', async () => {
    stashContaining({
      'current.owner.json': Date.now() - 3 * HOUR,
      'current.meta.json': Date.now() - 3 * HOUR,
    });

    await storePendingTranscript('current', { status: 'ready', segments: [], diarized: true });

    const unlinked = vi.mocked(fs.unlink).mock.calls.map(([p]) => String(p));
    expect(unlinked.some((p) => p.includes('current'))).toBe(false);
  });

  it('still sweeps other stale meetings while one is in flight', async () => {
    stashContaining({
      'current.owner.json': Date.now() - 3 * HOUR,
      'other.owner.json': Date.now() - 3 * HOUR,
    });

    await storePendingTranscript('current', { status: 'processing' });

    const unlinked = vi.mocked(fs.unlink).mock.calls.map(([p]) => String(p));
    expect(unlinked.some((p) => p.includes('other'))).toBe(true);
    expect(unlinked.some((p) => p.includes('current'))).toBe(false);
  });
});

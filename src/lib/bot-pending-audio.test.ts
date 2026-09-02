import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';

// Mock fs/promises so no real disk I/O happens.
vi.mock('fs/promises');

import {
  readPendingMeta,
  readPendingTranscript,
  setBotMeetingOwner,
  getBotMeetingOwner,
  assertBotMeetingOwner,
} from './bot-pending-audio';

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
    expect(label).toContain('[bot-pending-audio]');
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
    expect(label).toContain('[bot-pending-audio]');
    expect(id).toBe('meeting-789');
    expect(err).toBeInstanceOf(SyntaxError);
  });

  it('returns the parsed meta when the file is valid', async () => {
    const meta = {
      mimeType: 'audio/webm',
      participants: ['Alice'],
      durationSeconds: 120,
      hasRecording: true,
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
    expect(label).toContain('[bot-pending-audio]');
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

  it('setBotMeetingOwner writes the userId for the meeting', async () => {
    await setBotMeetingOwner('m1', 'user-A');
    const [, payload] = vi.mocked(fs.writeFile).mock.calls.at(-1)!;
    expect(JSON.parse(payload as string)).toMatchObject({ userId: 'user-A' });
  });

  it('getBotMeetingOwner returns the stored userId', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify({ userId: 'user-A', createdAt: 1 }));
    expect(await getBotMeetingOwner('m1')).toBe('user-A');
  });

  it('getBotMeetingOwner returns null (no log) when unbound (ENOENT)', async () => {
    vi.mocked(fs.readFile).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await getBotMeetingOwner('m1')).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('assertBotMeetingOwner is true only for the owning user', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ userId: 'user-A', createdAt: 1 }));
    expect(await assertBotMeetingOwner('m1', 'user-A')).toBe(true);
    expect(await assertBotMeetingOwner('m1', 'user-B')).toBe(false);
  });

  it('assertBotMeetingOwner denies by default when the meeting is unbound', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await assertBotMeetingOwner('m1', 'user-A')).toBe(false);
  });

  it('rejects an unsafe meetingId (path traversal)', async () => {
    await expect(getBotMeetingOwner('../etc/passwd')).rejects.toThrow(/Invalid meetingId/);
  });
});

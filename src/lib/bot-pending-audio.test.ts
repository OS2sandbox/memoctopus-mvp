import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';

// Mock fs/promises so no real disk I/O happens.
vi.mock('fs/promises');

vi.mock('@/lib/db', () => ({ db: {}, pool: {} }));
const recordEvent = vi.fn();
const recordServerEvent = vi.fn();
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordEvent: (...a: unknown[]) => recordEvent(...a),
  recordServerEvent: (...a: unknown[]) => recordServerEvent(...a),
}));

import {
  deletePendingAudio,
  deletePendingTranscript,
  sweepPendingBotData,
  storePendingAudio,
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
    const [line] = (console.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(console.error).toHaveBeenCalledWith(expect.any(String));
    expect(line).toContain('[bot-pending-audio readPendingMeta failed]');
    expect(line).toContain('code=EACCES');
    // Name/status/code only: never the message (paths) or the meeting id.
    expect(line).not.toContain('permission denied');
    expect(line).not.toContain('meeting-456');
  });

  it('returns null AND logs console.error when the file contains invalid JSON (SyntaxError)', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from('not-valid-json'));

    const result = await readPendingMeta('meeting-789');

    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledOnce();
    const [line] = (console.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(line).toContain('[bot-pending-audio readPendingMeta failed]');
    expect(line).toContain('name=SyntaxError');
    expect(line).not.toContain('meeting-789');
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
    const [line] = (console.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(line).toContain('[bot-pending-audio readPendingTranscript failed]');
    expect(line).toContain('code=EACCES');
    expect(line).not.toContain('meeting-456');
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

// ─── deletion of the server-held audio is recorded ─────────────────────────────

describe('deletePendingAudio audit (bot.audio_delete)', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    recordEvent.mockReset().mockResolvedValue({ status: 'stored' });
    recordServerEvent.mockReset().mockResolvedValue({ status: 'stored' });
    vi.mocked(fs.unlink).mockReset().mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a handoff deletion as a system event for the collecting user, on that request', async () => {
    const req = { headers: new Headers() };
    expect(await deletePendingAudio(ID, { trigger: 'handoff', actorUserId: 'u1', req })).toBe(true);
    expect(recordServerEvent).toHaveBeenCalledWith(req, {
      type: 'bot.audio_delete',
      source: 'system',
      actorUserId: 'u1',
      entityId: ID,
      details: { trigger: 'handoff' },
    });
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('without a request (the TTL sweep) it records with recordEvent', async () => {
    await deletePendingAudio(ID, { trigger: 'ttl', actorUserId: 'owner-1' });
    expect(recordEvent).toHaveBeenCalledWith({
      type: 'bot.audio_delete',
      source: 'system',
      actorUserId: 'owner-1',
      entityId: ID,
      details: { trigger: 'ttl' },
    });
  });

  it('records nothing when no audio file existed (a no-recording marker) or when no audit is asked for', async () => {
    vi.mocked(fs.unlink).mockImplementation((async (path: string) => {
      if (String(path).endsWith('.audio')) throw enoent();
    }) as never);
    expect(await deletePendingAudio(ID, { trigger: 'handoff', actorUserId: 'u1' })).toBe(false);
    vi.mocked(fs.unlink).mockResolvedValue(undefined as never);
    expect(await deletePendingAudio(ID)).toBe(true);
    expect(recordEvent).not.toHaveBeenCalled();
    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  it('keeps a meeting id that is not a uuid out of the entity', async () => {
    await deletePendingAudio('meeting-1', { trigger: 'ttl' });
    expect(recordEvent.mock.calls[0][0]).not.toHaveProperty('entityId');
    expect(recordEvent.mock.calls[0][0]).toMatchObject({ type: 'bot.audio_delete', details: { trigger: 'ttl' } });
  });

  it('the sweep (run when the next recording is stored) records one ttl deletion per expired recording, for its owner', async () => {
    const OLD = Date.now() - 2 * 60 * 60 * 1000;
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined as never);
    vi.mocked(fs.readdir).mockResolvedValue([`${ID}.meta.json`, `${ID}.owner.json`, `${ID}.transcript.json`] as never);
    vi.mocked(fs.readFile).mockImplementation((async (path: string) => {
      if (String(path).endsWith('.owner.json')) return JSON.stringify({ userId: 'owner-1', createdAt: OLD });
      return JSON.stringify({ createdAt: OLD });
    }) as never);
    await storePendingAudio('other-meeting', Buffer.from('x'), { mimeType: 'audio/webm', participants: [], durationSeconds: null, hasRecording: true });
    const ttl = recordEvent.mock.calls.filter((c) => (c[0] as { details: { trigger: string } }).details.trigger === 'ttl');
    expect(ttl).toHaveLength(1);
    expect(ttl[0][0]).toMatchObject({ type: 'bot.audio_delete', source: 'system', actorUserId: 'owner-1', entityId: ID });
  });
});

// ─── the sweep: data after 1 h, the owner binding only after 24 h and when nothing is left ──

describe('sweepPendingBotData', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const H = 60 * 60 * 1000;
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

  /** Files of one meeting with their ages in hours; `data` = which data files exist on disk for stat. */
  function disk(files: Record<string, number>, opts: { transcript?: unknown } = {}) {
    const now = Date.now();
    vi.mocked(fs.readdir).mockResolvedValue(Object.keys(files) as never);
    vi.mocked(fs.readFile).mockImplementation((async (path: string) => {
      const name = String(path).split('/').pop()!;
      if (!(name in files)) throw enoent();
      const createdAt = now - files[name] * H;
      if (name.endsWith('.owner.json')) return JSON.stringify({ userId: 'owner-1', createdAt });
      if (name.endsWith('.transcript.json')) return JSON.stringify({ createdAt, ...(opts.transcript as object) });
      return JSON.stringify({ createdAt });
    }) as never);
    const present = new Set(Object.keys(files).map((n) => n.replace('.meta.json', '.audio')).concat(Object.keys(files)));
    vi.mocked(fs.stat).mockImplementation((async (path: string) => {
      if (!present.has(String(path).split('/').pop()!)) throw enoent();
      return {} as never;
    }) as never);
    vi.mocked(fs.unlink).mockImplementation((async (path: string) => {
      present.delete(String(path).split('/').pop()!);
    }) as never);
  }
  const unlinked = () => vi.mocked(fs.unlink).mock.calls.map((c) => String(c[0]).split('/').pop());

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    recordEvent.mockReset().mockResolvedValue({ status: 'stored' });
    vi.mocked(fs.unlink).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('never deletes an owner binding before 24 h, even when the data is long gone (a live session keeps its owner)', async () => {
    disk({ [`${ID}.owner.json`]: 5 });
    expect(await sweepPendingBotData()).toEqual({ audio: 0, transcripts: 0, owners: 0 });
    expect(unlinked()).toEqual([]);
    disk({ [`${ID}.owner.json`]: 23.9 });
    await sweepPendingBotData();
    expect(unlinked()).toEqual([]);
  });

  it('deletes expired data after 1 h but keeps the owner until it is 24 h old', async () => {
    disk({ [`${ID}.meta.json`]: 3, [`${ID}.owner.json`]: 3 });
    expect(await sweepPendingBotData()).toEqual({ audio: 1, transcripts: 0, owners: 0 });
    expect(unlinked()).toEqual(expect.arrayContaining([`${ID}.audio`, `${ID}.meta.json`]));
    expect(unlinked()).not.toContain(`${ID}.owner.json`);
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'bot.audio_delete', actorUserId: 'owner-1', details: { trigger: 'ttl' } }));
  });

  it('removes the owner once it is older than 24 h and no data is left', async () => {
    disk({ [`${ID}.owner.json`]: 30 });
    expect(await sweepPendingBotData()).toEqual({ audio: 0, transcripts: 0, owners: 1 });
    expect(unlinked()).toEqual([`${ID}.owner.json`]);
  });

  it('keeps an old owner while a stash is still there (fresh data of the same meeting)', async () => {
    disk({ [`${ID}.meta.json`]: 0.2, [`${ID}.owner.json`]: 30 });
    expect(await sweepPendingBotData()).toEqual({ audio: 0, transcripts: 0, owners: 0 });
    expect(unlinked()).toEqual([]);
  });

  it('never touches the meeting whose own upload triggered the sweep', async () => {
    disk({ [`${ID}.meta.json`]: 3, [`${ID}.owner.json`]: 30 });
    expect(await sweepPendingBotData({ skipId: ID })).toEqual({ audio: 0, transcripts: 0, owners: 0 });
    expect(unlinked()).toEqual([]);
  });

  it('logs the deletion of an expired stashed transcript with object transcript', async () => {
    disk({ [`${ID}.transcript.json`]: 3, [`${ID}.owner.json`]: 3 }, { transcript: { status: 'ready' } });
    expect(await sweepPendingBotData()).toEqual({ audio: 0, transcripts: 1, owners: 0 });
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'bot.audio_delete', actorUserId: 'owner-1', details: { trigger: 'ttl', object: 'transcript' } }),
    );
  });

  it('survives a missing directory', async () => {
    vi.mocked(fs.readdir).mockRejectedValue(enoent());
    expect(await sweepPendingBotData()).toEqual({ audio: 0, transcripts: 0, owners: 0 });
  });
});

describe('deletePendingTranscript audit (bot.audio_delete, object transcript)', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    recordEvent.mockReset().mockResolvedValue({ status: 'stored' });
    recordServerEvent.mockReset().mockResolvedValue({ status: 'stored' });
    vi.mocked(fs.unlink).mockReset().mockResolvedValue(undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('records a handoff of a transcript that held text, on that request', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ status: 'ready', segments: [], createdAt: 1 }) as never);
    const req = { headers: new Headers() };
    expect(await deletePendingTranscript(ID, { trigger: 'handoff', actorUserId: 'u1', req })).toBe(true);
    expect(recordServerEvent).toHaveBeenCalledWith(req, {
      type: 'bot.audio_delete',
      source: 'system',
      actorUserId: 'u1',
      entityId: ID,
      details: { trigger: 'handoff', object: 'transcript' },
    });
  });

  it('records nothing for a processing/failed marker, a missing file, or when no audit is asked for', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ status: 'failed', createdAt: 1 }) as never);
    await deletePendingTranscript(ID, { trigger: 'handoff', actorUserId: 'u1' });
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ status: 'ready', createdAt: 1 }) as never);
    vi.mocked(fs.unlink).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ENOENT' }));
    expect(await deletePendingTranscript(ID, { trigger: 'handoff', actorUserId: 'u1' })).toBe(false);
    await deletePendingTranscript(ID);
    expect(recordEvent).not.toHaveBeenCalled();
    expect(recordServerEvent).not.toHaveBeenCalled();
  });
});

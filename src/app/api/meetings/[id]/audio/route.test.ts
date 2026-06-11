import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchema: vi.fn(),
  queryUserSchemaOne: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: { stat: vi.fn() },
}));

vi.mock('@/lib/audio/storage', () => ({
  getAudioFilePath: vi.fn().mockReturnValue('/fake/path/audio.webm'),
  createAudioReadStream: vi.fn(),
  deleteAudioFile: vi.fn().mockResolvedValue(undefined),
}));

import { GET, DELETE } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';
import fs from 'fs/promises';
import { createAudioReadStream, deleteAudioFile } from '@/lib/audio/storage';
import { EventEmitter } from 'events';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryOne = vi.mocked(queryUserSchemaOne);
const mockQueryMany = vi.mocked(queryUserSchema);
const mockStat = vi.mocked(fs.stat);
const mockCreateStream = vi.mocked(createAudioReadStream);
const mockDeleteAudioFile = vi.mocked(deleteAudioFile);

const MEETING_ID = 'meet-audio-1';
const PARAMS = { params: Promise.resolve({ id: MEETING_ID }) };
const BASE_URL = `http://localhost/api/meetings/${MEETING_ID}/audio`;

function makeFakeReadStream() {
  const emitter = new EventEmitter() as NodeJS.ReadableStream & EventEmitter & { destroy: () => void };
  emitter.destroy = vi.fn();
  // Immediately emit end so the ReadableStream closes without hanging
  setImmediate(() => emitter.emit('end'));
  return emitter;
}

// ─── GET /api/meetings/[id]/audio ────────────────────────────────────────────

describe('GET /api/meetings/[id]/audio', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
    mockStat.mockReset();
    mockCreateStream.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('returns 404 when no audio_files row exists for the meeting', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null as never);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Not found');
  });

  it('returns 404 when the file does not exist on disk', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ filename: 'recording.webm' } as never);
    mockStat.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('File not found');
  });

  it('returns 200 with correct headers for a full file request', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ filename: 'recording.webm' } as never);
    mockStat.mockResolvedValueOnce({ size: 1024 } as never);
    mockCreateStream.mockReturnValueOnce(makeFakeReadStream() as never);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/webm');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Length')).toBe('1024');
  });

  it('returns 206 partial content when a Range header is present', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ filename: 'recording.webm' } as never);
    mockStat.mockResolvedValueOnce({ size: 2000 } as never);
    mockCreateStream.mockReturnValueOnce(makeFakeReadStream() as never);

    const req = new Request(BASE_URL, { method: 'GET', headers: { Range: 'bytes=0-999' } });
    const res = await GET(req as never, PARAMS);

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-999/2000');
    expect(res.headers.get('Content-Length')).toBe('1000');
  });

  it('sets Content-Type to audio/mp4 for .mp4 files', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ filename: 'recording.mp4' } as never);
    mockStat.mockResolvedValueOnce({ size: 512 } as never);
    mockCreateStream.mockReturnValueOnce(makeFakeReadStream() as never);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);
    expect(res.headers.get('Content-Type')).toBe('audio/mp4');
  });

  it('sets Content-Type to audio/ogg for .ogg files', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ filename: 'recording.ogg' } as never);
    mockStat.mockResolvedValueOnce({ size: 512 } as never);
    mockCreateStream.mockReturnValueOnce(makeFakeReadStream() as never);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);
    expect(res.headers.get('Content-Type')).toBe('audio/ogg');
  });

  it('queries audio_files filtered by meeting_id and not soft-deleted', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null as never);

    await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);

    const [userId, sql, sqlParams] = mockQueryOne.mock.calls[0];
    expect(userId).toBe(FAKE_SESSION.user.id);
    expect(sql).toMatch(/audio_files/i);
    expect(sql).toMatch(/deleted_at IS NULL/i);
    expect(sqlParams).toContain(MEETING_ID);
  });
});

// ─── DELETE /api/meetings/[id]/audio ─────────────────────────────────────────

describe('DELETE /api/meetings/[id]/audio', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
    mockQueryMany.mockReset();
    mockDeleteAudioFile.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'), PARAMS);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('returns { ok: true } on successful deletion', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValueOnce([] as never);
    mockQueryMany.mockResolvedValueOnce([] as never);

    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('soft-deletes audio_files rows and then resets meeting status', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany
      .mockResolvedValueOnce([{ filename: 'rec.webm' }] as never)
      .mockResolvedValueOnce([] as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'), PARAMS);

    const [, softDeleteSql, softDeleteParams] = mockQueryMany.mock.calls[0];
    expect(softDeleteSql).toMatch(/UPDATE audio_files SET deleted_at/i);
    expect(softDeleteParams).toContain(MEETING_ID);

    const [, resetSql, resetParams] = mockQueryMany.mock.calls[1];
    expect(resetSql).toMatch(/UPDATE meetings SET status = 'recording'/i);
    expect(resetParams).toContain(MEETING_ID);
  });

  it('calls deleteAudioFile for each returned filename', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany
      .mockResolvedValueOnce([{ filename: 'a.webm' }, { filename: 'b.webm' }] as never)
      .mockResolvedValueOnce([] as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'), PARAMS);

    expect(mockDeleteAudioFile).toHaveBeenCalledTimes(2);
    expect(mockDeleteAudioFile).toHaveBeenCalledWith(FAKE_SESSION.user.id, 'a.webm');
    expect(mockDeleteAudioFile).toHaveBeenCalledWith(FAKE_SESSION.user.id, 'b.webm');
  });

  it('succeeds without calling deleteAudioFile when no files exist', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'), PARAMS);
    expect(res.status).toBe(200);
    expect(mockDeleteAudioFile).not.toHaveBeenCalled();
  });
});

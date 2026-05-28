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

import { GET, PATCH, DELETE } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryMany = vi.mocked(queryUserSchema);
const mockQueryOne = vi.mocked(queryUserSchemaOne);

const MEETING_ID = 'meet-abc';
const PARAMS = { params: Promise.resolve({ id: MEETING_ID }) };
const BASE_URL = `http://localhost/api/meetings/${MEETING_ID}`;

// ─── GET /api/meetings/[id] ───────────────────────────────────────────────────

describe('GET /api/meetings/[id]', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns the meeting for an authenticated user', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const meeting = { id: MEETING_ID, title: 'Møde', status: 'done' };
    mockQueryOne.mockResolvedValueOnce(meeting as never);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(meeting);
  });

  it('returns 404 when meeting does not exist', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null as never);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Not found');
  });
});

// ─── PATCH /api/meetings/[id] — status update ─────────────────────────────────

describe('PATCH /api/meetings/[id] — status update', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', { status: 'done' }), PARAMS);
    expect(res.status).toBe(401);
  });

  it.each(['recording', 'processing', 'review', 'minutes', 'done'] as const)(
    'accepts valid status "%s"',
    async (status) => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockQueryOne.mockResolvedValueOnce({} as never);

      const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', { status }), PARAMS);
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    },
  );

  it('returns 400 for an invalid status value', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', { status: 'invalid-status' }), PARAMS);
    expect(res.status).toBe(400);
  });

  it('updates with the correct user id and meeting id', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    await PATCH(makeJsonReq(BASE_URL, 'PATCH', { status: 'done' }), PARAMS);

    const [userId, , params] = mockQueryOne.mock.calls[0];
    expect(userId).toBe('user-123');
    expect(params).toContain(MEETING_ID);
  });

  it('returns 400 when body has neither status nor minutesId+content', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', { unrelated: true }), PARAMS);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Nothing to update');
  });
});

// ─── PATCH /api/meetings/[id] — minutes content save ──────────────────────────

describe('PATCH /api/meetings/[id] — minutes content save', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
  });

  const minutesBody = {
    minutesId: 'min-1',
    content: {
      sections: [{ key: 'beslutninger', label: 'Beslutninger', content: 'Ingen.' }],
    },
  };

  it('saves new version and returns incremented version number', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    // DB call sequence: fetch current → archive to versions → update → fetch new version row
    mockQueryOne.mockResolvedValueOnce({ id: 'min-1', version: 3, content: {} } as never);
    mockQueryOne.mockResolvedValueOnce({} as never);
    mockQueryOne.mockResolvedValueOnce({} as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'ver-1', content: {}, created_at: new Date().toISOString() } as never);

    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', minutesBody), PARAMS);

    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(4); // 3 + 1
  });

  it('returns 404 when the minutes record does not exist', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null as never);

    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', minutesBody), PARAMS);
    expect(res.status).toBe(404);
  });

  it('archives the old content before updating', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const oldContent = { sections: [{ key: 'k', label: 'L', content: 'Old.' }] };
    // DB call sequence: fetch current → archive to versions → update → fetch new version row
    mockQueryOne.mockResolvedValueOnce({ id: 'min-1', version: 1, content: oldContent } as never);
    mockQueryOne.mockResolvedValueOnce({} as never);
    mockQueryOne.mockResolvedValueOnce({} as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    await PATCH(makeJsonReq(BASE_URL, 'PATCH', minutesBody), PARAMS);

    const [, insertSql, insertParams] = mockQueryOne.mock.calls[1];
    expect(insertSql).toMatch(/INSERT INTO minute_versions/i);
    expect(insertParams).toContain(JSON.stringify(oldContent));
  });
});

// ─── DELETE /api/meetings/[id] ────────────────────────────────────────────────

describe('DELETE /api/meetings/[id]', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryMany.mockReset();
    mockQueryOne.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'), PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns { ok: true } on successful deletion', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValueOnce([] as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('soft-deletes audio files before hard-deleting the meeting', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValueOnce([] as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'), PARAMS);

    const [, softDeleteSql] = mockQueryMany.mock.calls[0];
    expect(softDeleteSql).toMatch(/UPDATE audio_files SET deleted_at/i);

    const [, hardDeleteSql] = mockQueryOne.mock.calls[0];
    expect(hardDeleteSql).toMatch(/DELETE FROM meetings/i);
  });

  it('soft-deletes audio files scoped to the meeting id', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValueOnce([] as never);
    mockQueryOne.mockResolvedValueOnce({} as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'), PARAMS);

    const [, , audioParams] = mockQueryMany.mock.calls[0];
    expect(audioParams).toContain(MEETING_ID);
  });
});

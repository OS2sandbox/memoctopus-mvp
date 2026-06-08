import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchemaOne: vi.fn(),
}));

import { PATCH } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryOne = vi.mocked(queryUserSchemaOne);

const MEETING_ID = 'meet-min-1';
const PARAMS = { params: Promise.resolve({ id: MEETING_ID }) };
const BASE_URL = `http://localhost/api/meetings/${MEETING_ID}/minutes`;

const validBody = {
  minutesId: 'min-1',
  content: {
    sections: [{ key: 'beslutninger', label: 'Beslutninger', content: 'Ingen.' }],
  },
};

// ─── PATCH /api/meetings/[id]/minutes ────────────────────────────────────────

describe('PATCH /api/meetings/[id]/minutes', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', validBody), PARAMS);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('returns 400 when minutesId is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await PATCH(
      makeJsonReq(BASE_URL, 'PATCH', { content: validBody.content }),
      PARAMS,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when content.sections is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const res = await PATCH(
      makeJsonReq(BASE_URL, 'PATCH', { minutesId: 'min-1', content: {} }),
      PARAMS,
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when the minutes record does not exist', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null as never);

    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', validBody), PARAMS);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Not found');
  });

  it('returns 200 with incremented version number on success', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne
      .mockResolvedValueOnce({ id: 'min-1', version: 2, content: {} } as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({ id: 'ver-1', content: {}, created_at: new Date().toISOString() } as never);

    const res = await PATCH(makeJsonReq(BASE_URL, 'PATCH', validBody), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(3);
  });

  it('archives the current content into minute_versions before updating', async () => {
    const oldContent = { sections: [{ key: 'k', label: 'L', content: 'Old.' }] };
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne
      .mockResolvedValueOnce({ id: 'min-1', version: 1, content: oldContent } as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never);

    await PATCH(makeJsonReq(BASE_URL, 'PATCH', validBody), PARAMS);

    const archiveCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && sql.includes('INSERT INTO minute_versions'),
    );
    expect(archiveCall).toBeDefined();
    expect(archiveCall![2]).toContain(JSON.stringify(oldContent));
  });

  it('updates the minutes row with new content after archiving', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne
      .mockResolvedValueOnce({ id: 'min-1', version: 5, content: {} } as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never);

    await PATCH(makeJsonReq(BASE_URL, 'PATCH', validBody), PARAMS);

    const updateCall = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && sql.includes('UPDATE minutes SET content'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![2]).toContain(JSON.stringify(validBody.content));
  });

  it('verifies ownership by scoping the lookup to both minutesId and meeting id', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null as never);

    await PATCH(makeJsonReq(BASE_URL, 'PATCH', validBody), PARAMS);

    const [userId, sql, sqlParams] = mockQueryOne.mock.calls[0];
    expect(userId).toBe(FAKE_SESSION.user.id);
    expect(sql).toMatch(/SELECT.*FROM minutes WHERE id/i);
    expect(sqlParams).toContain('min-1');
    expect(sqlParams).toContain(MEETING_ID);
  });

  it('returns the new version row in the response body', async () => {
    const currentContent = { sections: [{ key: 'old', label: 'Old', content: 'Before.' }] };
    const archiveMeta = { id: 'ver-42', created_at: '2025-01-01T00:00:00Z' };
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne
      .mockResolvedValueOnce({ id: 'min-1', version: 10, content: currentContent } as never) // SELECT current
      .mockResolvedValueOnce(archiveMeta as never) // INSERT archive RETURNING id, created_at
      .mockResolvedValueOnce({} as never); // UPDATE minutes

    const body = await (await PATCH(makeJsonReq(BASE_URL, 'PATCH', validBody), PARAMS)).json();
    expect(body.newVersion).toEqual({ ...archiveMeta, content: currentContent });
  });
});

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

import { DELETE } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchema } from '@/lib/db/user-schema';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryMany = vi.mocked(queryUserSchema);

const BASE_URL = 'http://localhost/api/account/sensitive';

describe('DELETE /api/account/sensitive', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryMany.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('returns { processed: 0, total: 0 } when no meetings exist', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValueOnce([] as never);

    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: 0, total: 0 });
  });

  it('returns { processed, total } equal to the number of non-redacted meetings', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const meetings = [{ id: 'meet-1' }, { id: 'meet-2' }, { id: 'meet-3' }];
    // First call fetches the meeting list; subsequent calls are the 3 UPDATE groups per meeting.
    mockQueryMany
      .mockResolvedValueOnce(meetings as never)
      .mockResolvedValue([] as never);

    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(3);
    expect(body.total).toBe(3);
  });

  it('selects only non-redacted meetings', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValue([] as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'));

    const [userId, sql] = mockQueryMany.mock.calls[0];
    expect(userId).toBe('user-123');
    expect(sql).toMatch(/status != 'redacted'/i);
  });

  it('clears transcript raw_text and segments for each meeting', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const meetings = [{ id: 'meet-1' }];
    mockQueryMany
      .mockResolvedValueOnce(meetings as never)
      .mockResolvedValue([] as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'));

    const transcriptCall = mockQueryMany.mock.calls.find(([, sql]) =>
      /UPDATE transcripts/i.test(sql),
    );
    expect(transcriptCall).toBeDefined();
    const [, transcriptSql, transcriptParams] = transcriptCall!;
    expect(transcriptSql).toMatch(/raw_text = ''/i);
    expect(transcriptSql).toMatch(/segments = '\[\]'/i);
    expect(transcriptParams).toContain('meet-1');
  });

  it('soft-deletes audio files for each meeting', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const meetings = [{ id: 'meet-1' }];
    mockQueryMany
      .mockResolvedValueOnce(meetings as never)
      .mockResolvedValue([] as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'));

    const audioCall = mockQueryMany.mock.calls.find(([, sql]) =>
      /UPDATE audio_files SET deleted_at/i.test(sql),
    );
    expect(audioCall).toBeDefined();
    const [, , audioParams] = audioCall!;
    expect(audioParams).toContain('meet-1');
  });

  it('marks each meeting status as redacted', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const meetings = [{ id: 'meet-1' }];
    mockQueryMany
      .mockResolvedValueOnce(meetings as never)
      .mockResolvedValue([] as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'));

    const redactCall = mockQueryMany.mock.calls.find(([, sql]) =>
      /UPDATE meetings SET status = 'redacted'/i.test(sql),
    );
    expect(redactCall).toBeDefined();
    const [, , redactParams] = redactCall!;
    expect(redactParams).toContain('meet-1');
  });

  it('sets redacted_by to "user"', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const meetings = [{ id: 'meet-1' }];
    mockQueryMany
      .mockResolvedValueOnce(meetings as never)
      .mockResolvedValue([] as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'));

    const redactCall = mockQueryMany.mock.calls.find(([, sql]) =>
      /redacted_by/i.test(sql),
    );
    expect(redactCall).toBeDefined();
    const [, redactSql] = redactCall!;
    expect(redactSql).toMatch(/redacted_by = 'user'/i);
  });

  it('processes each meeting independently (3 queries per meeting after the initial fetch)', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const meetings = [{ id: 'meet-a' }, { id: 'meet-b' }];
    mockQueryMany
      .mockResolvedValueOnce(meetings as never)
      .mockResolvedValue([] as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'));

    // 1 fetch + 3 updates × 2 meetings = 7 total calls
    expect(mockQueryMany).toHaveBeenCalledTimes(7);
  });

  it('uses the session user id for all queries', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    const meetings = [{ id: 'meet-1' }];
    mockQueryMany
      .mockResolvedValueOnce(meetings as never)
      .mockResolvedValue([] as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'));

    for (const call of mockQueryMany.mock.calls) {
      expect(call[0]).toBe('user-123');
    }
  });
});

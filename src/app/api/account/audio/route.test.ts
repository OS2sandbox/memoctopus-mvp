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

const BASE_URL = 'http://localhost/api/account/audio';

describe('DELETE /api/account/audio', () => {
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

  it('returns { ok: true } on success', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValueOnce([] as never);

    const res = await DELETE(makeJsonReq(BASE_URL, 'DELETE'));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('soft-deletes all non-deleted audio files for the session user', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValueOnce([] as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'));

    expect(mockQueryMany).toHaveBeenCalledWith('user-123', expect.stringMatching(/UPDATE audio_files SET deleted_at/i));
  });

  it('filters to rows where deleted_at IS NULL', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValueOnce([] as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'));

    const [, sql] = mockQueryMany.mock.calls[0];
    expect(sql).toMatch(/deleted_at IS NULL/i);
  });

  it('does not pass extra query params (bulk update, no WHERE id)', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryMany.mockResolvedValueOnce([] as never);

    await DELETE(makeJsonReq(BASE_URL, 'DELETE'));

    const call = mockQueryMany.mock.calls[0];
    expect(call[2]).toBeUndefined();
  });
});

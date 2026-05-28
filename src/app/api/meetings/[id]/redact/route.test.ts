import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchemaOne: vi.fn(),
  queryUserSchema: vi.fn(),
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne, queryUserSchema } from '@/lib/db/user-schema';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryOne = vi.mocked(queryUserSchemaOne);
const mockQueryMany = vi.mocked(queryUserSchema);

const BASE_URL = 'http://localhost/api/meetings/meet-1/redact';
const PARAMS = { params: Promise.resolve({ id: 'meet-1' }) };

// ─── POST /api/meetings/[id]/redact ──────────────────────────────────────────

describe('POST /api/meetings/[id]/redact', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
    mockQueryMany.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeJsonReq(BASE_URL, 'POST'), PARAMS);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('returns 404 when meeting not found', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST'), PARAMS);
    expect(res.status).toBe(404);
  });

  it('returns 409 when meeting is already redacted', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'redacted' } as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST'), PARAMS);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Already redacted');
  });

  it('returns 200 with redactedAt on success', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'review' } as never);
    mockQueryMany.mockResolvedValue([] as never); // transcript update, audio update, meeting update

    const res = await POST(makeJsonReq(BASE_URL, 'POST'), PARAMS);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.redactedAt).toBeDefined();
    expect(typeof body.redactedAt).toBe('string');
  });

  it('redacts transcript — clears raw_text and segments', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'minutes' } as never);
    mockQueryMany.mockResolvedValue([] as never);

    await POST(makeJsonReq(BASE_URL, 'POST'), PARAMS);

    const transcriptCall = mockQueryMany.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && sql.includes('transcripts') && sql.includes("raw_text = ''"),
    );
    expect(transcriptCall).toBeDefined();
  });

  it('soft-deletes audio files during redaction', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'review' } as never);
    mockQueryMany.mockResolvedValue([] as never);

    await POST(makeJsonReq(BASE_URL, 'POST'), PARAMS);

    const audioCall = mockQueryMany.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && sql.includes('audio_files') && sql.includes('deleted_at'),
    );
    expect(audioCall).toBeDefined();
  });

  it('updates meeting status to redacted', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status: 'review' } as never);
    mockQueryMany.mockResolvedValue([] as never);

    await POST(makeJsonReq(BASE_URL, 'POST'), PARAMS);

    const meetingCall = mockQueryMany.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && sql.includes("status = 'redacted'"),
    );
    expect(meetingCall).toBeDefined();
  });

  it('allows redaction from any non-redacted status', async () => {
    for (const status of ['recording', 'processing', 'review', 'minutes', 'done']) {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockQueryOne.mockResolvedValueOnce({ id: 'meet-1', status } as never);
      mockQueryMany.mockResolvedValue([] as never);

      const res = await POST(makeJsonReq(BASE_URL, 'POST'), PARAMS);
      expect(res.status).toBe(200);
    }
  });
});

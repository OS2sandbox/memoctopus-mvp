import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));

const store = vi.hoisted(() => ({
  markStepSeen: vi.fn(),
  skipTour: vi.fn(),
  completeTour: vi.fn(),
  resetHints: vi.fn(),
}));
vi.mock('@/lib/onboarding/store', () => store);

import { POST } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const URL = 'http://localhost/api/onboarding/step';
const mockGetSession = vi.mocked(auth.api.getSession);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mockGetSession.mockReset();
  mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  Object.values(store).forEach((fn) => fn.mockReset());
});

describe('POST /api/onboarding/step', () => {
  it('returns 401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeJsonReq(URL, 'POST', { stepId: 'dashboard.record-button' }));
    expect(res.status).toBe(401);
    expect(store.markStepSeen).not.toHaveBeenCalled();
  });

  it('records a global hint for the signed-in user', async () => {
    const res = await POST(makeJsonReq(URL, 'POST', { stepId: 'dashboard.record-button' }));
    expect(res.status).toBe(200);
    expect(store.markStepSeen).toHaveBeenCalledWith('user-123', 'dashboard.record-button', null);
  });

  it('records a per-meeting hint with the meeting id', async () => {
    const res = await POST(
      makeJsonReq(URL, 'POST', { stepId: 'recording.audio-lifecycle', meetingId: 'm-1' }),
    );
    expect(res.status).toBe(200);
    expect(store.markStepSeen).toHaveBeenCalledWith('user-123', 'recording.audio-lifecycle', 'm-1');
  });

  it.each([
    ['a missing stepId', {}],
    ['an unknown stepId', { stepId: 'not.a.real.step' }],
    ['a non-string stepId', { stepId: 42 }],
    ['an inherited object key as stepId', { stepId: 'constructor' }],
    ['a meetingId that is not a string', { stepId: 'dashboard.record-button', meetingId: 42 }],
    ['an over-long meetingId', { stepId: 'dashboard.record-button', meetingId: 'x'.repeat(101) }],
    ['an empty meetingId', { stepId: 'dashboard.record-button', meetingId: '' }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const res = await POST(makeJsonReq(URL, 'POST', body));
    expect(res.status).toBe(400);
    expect(store.markStepSeen).not.toHaveBeenCalled();
  });

  it('answers 400, not 500, to a JSON null body', async () => {
    const res = await POST(makeJsonReq(URL, 'POST', null));
    expect(res.status).toBe(400);
  });

  it.each([
    ['skip-tour', 'skipTour'],
    ['complete-tour', 'completeTour'],
    ['reset-hints', 'resetHints'],
  ] as const)('runs the %s action', async (action, fn) => {
    const res = await POST(makeJsonReq(URL, 'POST', { action }));
    expect(res.status).toBe(200);
    expect(store[fn]).toHaveBeenCalledWith('user-123');
  });
});

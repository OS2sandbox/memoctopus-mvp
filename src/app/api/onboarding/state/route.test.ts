import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));

const store = vi.hoisted(() => ({
  getOnboardingState: vi.fn(),
  getSeenSteps: vi.fn(),
}));
vi.mock('@/lib/onboarding/store', () => store);

import { GET } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

beforeEach(() => {
  mockGetSession.mockReset();
  mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  store.getOnboardingState.mockReset();
  store.getSeenSteps.mockReset();
  store.getOnboardingState.mockResolvedValue({ tourSkipped: false, tourCompleted: false, lastStepId: null });
  store.getSeenSteps.mockResolvedValue([]);
});

describe('GET /api/onboarding/state', () => {
  it('returns 401 without a session', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(store.getOnboardingState).not.toHaveBeenCalled();
    expect(store.getSeenSteps).not.toHaveBeenCalled();
  });

  it('looks up state and seen steps for the signed-in user', async () => {
    await GET();
    expect(store.getOnboardingState).toHaveBeenCalledWith('user-123');
    expect(store.getSeenSteps).toHaveBeenCalledWith('user-123');
  });

  it('merges state and seen steps into one payload', async () => {
    store.getOnboardingState.mockResolvedValueOnce({
      tourSkipped: false,
      tourCompleted: true,
      lastStepId: 'dashboard.record-button',
    });
    store.getSeenSteps.mockResolvedValueOnce([
      { stepId: 'dashboard.record-button', meetingId: null },
      { stepId: 'recording.audio-lifecycle', meetingId: 'm-1' },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      tourSkipped: false,
      tourCompleted: true,
      lastStepId: 'dashboard.record-button',
      seen: [
        { stepId: 'dashboard.record-button', meetingId: null },
        { stepId: 'recording.audio-lifecycle', meetingId: 'm-1' },
      ],
    });
  });

  it('answers for a genuinely fresh user with an empty seen list', async () => {
    const res = await GET();
    await expect(res.json()).resolves.toEqual({
      tourSkipped: false,
      tourCompleted: false,
      lastStepId: null,
      seen: [],
    });
  });
});

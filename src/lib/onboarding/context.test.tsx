// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, waitFor } from '@testing-library/react';
import { OnboardingProvider, useOnboarding } from './context';
import { renderWithOnboarding } from '@/test/onboarding';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Probe({ onReady }: { onReady?: (ctx: ReturnType<typeof useOnboarding>) => void }) {
  const ctx = useOnboarding();
  onReady?.(ctx);
  return (
    <div>
      <span data-testid="seen">{String(ctx.isStepSeen('some.step'))}</span>
      <span data-testid="first">{String(ctx.isFirstTimeUser)}</span>
    </div>
  );
}

const fresh = { tourSkipped: false, tourCompleted: false, seen: [] };

describe('OnboardingProvider — unavailable state', () => {
  it('shows nothing when the server could not load onboarding state', () => {
    renderWithOnboarding(<Probe />, { ...fresh, unavailable: true });

    // Every hint counts as seen (so none render) and no welcome dialog opens, even though
    // the seen list is empty, which would otherwise look like a brand-new user.
    expect(screen.getByTestId('seen').textContent).toBe('true');
    expect(screen.getByTestId('first').textContent).toBe('false');
  });

  it('still behaves normally for a genuinely new user', () => {
    renderWithOnboarding(<Probe />, fresh);

    expect(screen.getByTestId('seen').textContent).toBe('false');
    expect(screen.getByTestId('first').textContent).toBe('true');
  });
});

describe('OnboardingProvider — saving', () => {
  async function markSeenOnce() {
    let markSeen!: (id: string, meetingId?: string | null) => void;
    renderWithOnboarding(<Probe onReady={(c) => (markSeen = c.markSeen)} />, fresh);
    await act(async () => {
      markSeen('recording.audio-lifecycle', 'm-1');
    });
  }

  it('posts the step and meeting id', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await markSeenOnce();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/onboarding/step',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ stepId: 'recording.audio-lifecycle', meetingId: 'm-1' }),
      }),
    );
  });

  it('warns instead of silently ignoring a rejected save', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await markSeenOnce();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('500'), expect.anything());
  });

  it('does not throw when the network is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(markSeenOnce()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled(); // offline is expected, not worth noise
  });

  it('does not re-POST when the same step is marked seen again', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    let markSeen!: (id: string, meetingId?: string | null) => void;
    renderWithOnboarding(<Probe onReady={(c) => (markSeen = c.markSeen)} />, fresh);

    await act(async () => markSeen('recording.audio-lifecycle', 'm-1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Dismissing an already-seen hint a second time (e.g. a second mounted
    // instance of the same step) must not fire a wasted request.
    await act(async () => markSeen('recording.audio-lifecycle', 'm-1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('OnboardingProvider — client-side fetch (no `initial` prop)', () => {
  it('fetches /api/onboarding/state itself and behaves like "unavailable" until it resolves', async () => {
    let resolveFetch!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => (resolveFetch = r)));

    render(
      <OnboardingProvider>
        <Probe />
      </OnboardingProvider>,
    );

    expect(fetchMock).toHaveBeenCalledWith('/api/onboarding/state');
    // Nothing known yet — must not flash "first-time user" before the fetch resolves.
    expect(screen.getByTestId('seen').textContent).toBe('true');
    expect(screen.getByTestId('first').textContent).toBe('false');

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ tourSkipped: false, tourCompleted: false, seen: [] }),
      });
    });

    await waitFor(() => expect(screen.getByTestId('first').textContent).toBe('true'));
  });

  it('treats a fetch failure the same as the server-side "could not load" fallback', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <OnboardingProvider>
        <Probe />
      </OnboardingProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('seen').textContent).toBe('true'));
    expect(screen.getByTestId('first').textContent).toBe('false');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not fetch at all when `initial` is supplied', () => {
    renderWithOnboarding(<Probe />, fresh);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

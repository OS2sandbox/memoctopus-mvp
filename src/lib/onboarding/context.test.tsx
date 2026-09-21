// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { OnboardingProvider, useOnboarding } from './context';

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
    render(
      <OnboardingProvider initial={{ ...fresh, unavailable: true }}>
        <Probe />
      </OnboardingProvider>,
    );

    // Every hint counts as seen (so none render) and no welcome dialog opens, even though
    // the seen list is empty, which would otherwise look like a brand-new user.
    expect(screen.getByTestId('seen').textContent).toBe('true');
    expect(screen.getByTestId('first').textContent).toBe('false');
  });

  it('still behaves normally for a genuinely new user', () => {
    render(
      <OnboardingProvider initial={fresh}>
        <Probe />
      </OnboardingProvider>,
    );

    expect(screen.getByTestId('seen').textContent).toBe('false');
    expect(screen.getByTestId('first').textContent).toBe('true');
  });
});

describe('OnboardingProvider — saving', () => {
  async function markSeenOnce() {
    let markSeen!: (id: string, meetingId?: string | null) => void;
    render(
      <OnboardingProvider initial={fresh}>
        <Probe onReady={(c) => (markSeen = c.markSeen)} />
      </OnboardingProvider>,
    );
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
});

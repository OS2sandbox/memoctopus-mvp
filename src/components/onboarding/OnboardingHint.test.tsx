// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { OnboardingProvider } from '@/lib/onboarding/context';
import { OnboardingHint } from './OnboardingHint';
import { getStep } from '@/lib/onboarding/steps';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);
  // Radix Popper measures its content with ResizeObserver, which jsdom lacks.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fresh = { tourSkipped: true, tourCompleted: false, seen: [] };

function Provider({ children }: { children: React.ReactNode }) {
  return <OnboardingProvider initial={fresh}>{children}</OnboardingProvider>;
}

// Bodies of every /api/onboarding/step save, in call order.
function saves(): Array<{ stepId: string; meetingId: string | null }> {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

const A = 'topbar.arkiv-explainer';
const B = 'topbar.unsaved-audio';
const C = 'dashboard.record-button';

describe('OnboardingHint — dismissal saves once', () => {
  it('saves exactly once when dismissed with the button', async () => {
    render(
      <Provider>
        <OnboardingHint stepId={A}>
          <span>anchor</span>
        </OnboardingHint>
      </Provider>,
    );
    expect(screen.getByText(getStep(A).copy)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText('forstået'));
    });

    expect(screen.queryByText(getStep(A).copy)).toBeNull();
    expect(saves()).toEqual([{ stepId: A, meetingId: null }]);
  });

  it('saves exactly once when dismissed with Escape', async () => {
    render(
      <Provider>
        <OnboardingHint stepId={A}>
          <span>anchor</span>
        </OnboardingHint>
      </Provider>,
    );
    expect(screen.getByText(getStep(A).copy)).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(screen.queryByText(getStep(A).copy)).toBeNull();
    expect(saves()).toEqual([{ stepId: A, meetingId: null }]);
  });

  it('still marks a shown hint seen once when it unmounts undismissed', () => {
    const { unmount } = render(
      <Provider>
        <OnboardingHint stepId={A}>
          <span>anchor</span>
        </OnboardingHint>
      </Provider>,
    );
    unmount();
    expect(saves()).toEqual([{ stepId: A, meetingId: null }]);
  });
});

describe('OnboardingHint — one instance reused for different steps', () => {
  function Bar({ step, meetingId }: { step: string; meetingId: string | null }) {
    return (
      <Provider>
        <OnboardingHint key="/arkiv" stepId={step} meetingId={meetingId}>
          <span>anchor</span>
        </OnboardingHint>
      </Provider>
    );
  }

  it('does not mark the new step seen when it was only queued, never shown', () => {
    // C mounts first and holds the slot; the reused instance shows A, then is
    // re-pointed at B while C is still ahead of it in the queue.
    function Tree({ step, meetingId }: { step: string; meetingId: string | null }) {
      return (
        <Provider>
          <OnboardingHint stepId={step} meetingId={meetingId}>
            <span>anchor</span>
          </OnboardingHint>
          <OnboardingHint stepId={C}>
            <span>other</span>
          </OnboardingHint>
        </Provider>
      );
    }
    const { rerender, unmount } = render(<Tree step={A} meetingId={null} />);
    expect(screen.getByText(getStep(A).copy)).toBeTruthy();

    rerender(<Tree step={B} meetingId="m-1" />);
    // A was shown, so leaving it counts as seen; B is queued behind C.
    expect(saves()).toEqual([{ stepId: A, meetingId: null }]);
    expect(screen.queryByText(getStep(B).copy)).toBeNull();

    unmount();
    // B was never on screen: it must not be recorded as seen.
    expect(saves().some((s) => s.stepId === B)).toBe(false);
  });

  it('does mark the new step seen when it was shown', () => {
    const { rerender, unmount } = render(<Bar step={A} meetingId={null} />);
    rerender(<Bar step={B} meetingId="m-1" />);
    expect(screen.getByText(getStep(B).copy)).toBeTruthy();
    unmount();
    expect(saves()).toEqual([
      { stepId: A, meetingId: null },
      { stepId: B, meetingId: 'm-1' },
    ]);
  });
});

describe('OnboardingHint — repeated step', () => {
  it('lets the next instance show when the owning instance unmounts', () => {
    const D = 'review.speaker-assign';
    function Rows({ rows }: { rows: string[] }) {
      return (
        <Provider>
          {/* C is ahead in the queue, so no row's hint is open yet. */}
          <OnboardingHint stepId={C}>
            <span>first</span>
          </OnboardingHint>
          {rows.map((r) => (
            <OnboardingHint key={r} stepId={D}>
              <span>{r}</span>
            </OnboardingHint>
          ))}
        </Provider>
      );
    }
    const { rerender } = render(<Rows rows={['row-1', 'row-2', 'row-3']} />);
    expect(screen.queryByText(getStep(D).copy)).toBeNull();

    // The row that owns the slot goes away while still queued (never shown).
    rerender(<Rows rows={['row-2', 'row-3']} />);
    // Dismiss C: the step must now show on a remaining row, once.
    fireEvent.click(screen.getByText('forstået'));
    expect(screen.getAllByText(getStep(D).copy)).toHaveLength(1);
  });
});

describe('OnboardingHint — unknown stepId', () => {
  it('renders children plainly and never opens a hint, instead of crashing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <Provider>
        <OnboardingHint stepId="not.a.real.step">
          <span>anchor content</span>
        </OnboardingHint>
      </Provider>,
    );

    expect(screen.getByText('anchor content')).toBeTruthy();
    expect(screen.queryByText('forstået')).toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('not.a.real.step'));
    spy.mockRestore();
  });
});

// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { OnboardingProvider } from '@/lib/onboarding/context';
import { OnboardingTooltip } from './OnboardingTooltip';
import { getStep } from '@/lib/onboarding/steps';

beforeEach(() => {
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

const fresh = { tourSkipped: true, tourCompleted: true, seen: [] };

function Provider({ children }: { children: React.ReactNode }) {
  return <OnboardingProvider initial={fresh}>{children}</OnboardingProvider>;
}

const STEP = 'recording.star-marker';

describe('OnboardingTooltip — known step', () => {
  it('shows the step copy on focus, and hides it again on blur', async () => {
    render(
      <Provider>
        <OnboardingTooltip stepId={STEP}>
          <span tabIndex={0}>★</span>
        </OnboardingTooltip>
      </Provider>,
    );

    expect(screen.queryByText(getStep(STEP).copy)).toBeNull();

    await act(async () => {
      fireEvent.focus(screen.getByText('★'));
    });
    await waitFor(() => expect(screen.getByText(getStep(STEP).copy)).toBeTruthy());

    await act(async () => {
      fireEvent.blur(screen.getByText('★'));
    });
    await waitFor(() => expect(screen.queryByText(getStep(STEP).copy)).toBeNull());
  });

  it('never persists — the same step can be shown over and over', async () => {
    render(
      <Provider>
        <OnboardingTooltip stepId={STEP}>
          <span tabIndex={0}>★</span>
        </OnboardingTooltip>
      </Provider>,
    );

    for (let i = 0; i < 2; i++) {
      await act(async () => fireEvent.focus(screen.getByText('★')));
      await waitFor(() => expect(screen.getByText(getStep(STEP).copy)).toBeTruthy());
      await act(async () => fireEvent.blur(screen.getByText('★')));
      await waitFor(() => expect(screen.queryByText(getStep(STEP).copy)).toBeNull());
    }
  });
});

describe('OnboardingTooltip — unknown stepId', () => {
  it('renders children plainly and never opens a tooltip, instead of crashing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <Provider>
        <OnboardingTooltip stepId="not.a.real.step">
          <span tabIndex={0}>anchor content</span>
        </OnboardingTooltip>
      </Provider>,
    );

    expect(screen.getByText('anchor content')).toBeTruthy();
    await act(async () => fireEvent.focus(screen.getByText('anchor content')));
    expect(screen.queryByRole('tooltip')).toBeNull();
    spy.mockRestore();
  });
});

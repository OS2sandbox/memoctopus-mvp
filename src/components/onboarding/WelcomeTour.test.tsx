// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useOnboarding } from '@/lib/onboarding/context';
import { getStep } from '@/lib/onboarding/steps';
import { FRESH_ONBOARDING, renderWithOnboarding } from '@/test/onboarding';
import { OnboardingHint } from './OnboardingHint';
import { WelcomeTour } from './WelcomeTour';

function Probe() {
  const { isStepSeen, openWelcome } = useOnboarding();
  return (
    <>
      <button onClick={openWelcome}>open</button>
      <div data-testid="seen">{isStepSeen('topbar.arkiv-explainer') ? 'seen' : 'unseen'}</div>
    </>
  );
}

function setup() {
  return renderWithOnboarding(
    <>
      <Probe />
      <WelcomeTour />
    </>,
    { tourSkipped: false, tourCompleted: true, seen: [{ stepId: 'topbar.arkiv-explainer', meetingId: null }] },
  );
}

const RECORD = 'dashboard.record-button';

/** A brand-new user: the welcome dialog opens by itself, with a hint mounted behind it. */
function setupFirstVisit() {
  return renderWithOnboarding(
    <>
      <OnboardingHint stepId={RECORD}>
        <button>optag</button>
      </OnboardingHint>
      <WelcomeTour />
    </>,
    FRESH_ONBOARDING,
  );
}

const fetchMock = vi.fn();

function postedBodies(): unknown[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe('WelcomeTour', () => {
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

  it('opens by itself for a first-time user', () => {
    setupFirstVisit();
    expect(screen.getByRole('dialog', { name: 'Sådan fungerer OS2taletiltekst' })).toBeTruthy();
  });

  it('keeps every hint closed while the welcome dialog is showing', () => {
    setupFirstVisit();
    expect(screen.getByRole('dialog', { name: 'Sådan fungerer OS2taletiltekst' })).toBeTruthy();
    expect(screen.queryByText(getStep(RECORD).copy)).toBeNull();
  });

  it('"kom i gang" resets seen hints and tells the server', () => {
    setup();
    expect(screen.getByTestId('seen').textContent).toBe('seen');
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('kom i gang'));

    expect(screen.getByTestId('seen').textContent).toBe('unseen');
    expect(postedBodies()).toEqual([{ action: 'reset-hints' }]);
  });

  it('"kom i gang" shows the hints once the dialog is gone', async () => {
    setupFirstVisit();
    await act(async () => {
      fireEvent.click(screen.getByText('kom i gang'));
    });

    expect(screen.queryByRole('dialog', { name: 'Sådan fungerer OS2taletiltekst' })).toBeNull();
    expect(screen.getByText(getStep(RECORD).copy)).toBeTruthy();
    // "kom i gang" is not a skip.
    expect(postedBodies()).not.toContainEqual({ action: 'skip-tour' });
  });

  it('"spring over" keeps seen hints and tells the server', () => {
    setup();
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('spring over'));

    expect(screen.getByTestId('seen').textContent).toBe('seen');
    expect(postedBodies()).toEqual([{ action: 'skip-tour' }]);
  });

  it('"spring over" means no hints pop up afterwards', async () => {
    setupFirstVisit();
    await act(async () => {
      fireEvent.click(screen.getByText('spring over'));
    });

    expect(screen.queryByRole('dialog', { name: 'Sådan fungerer OS2taletiltekst' })).toBeNull();
    expect(screen.queryByText(getStep(RECORD).copy)).toBeNull();
    expect(screen.getByText('optag')).toBeTruthy();
  });

  it('closing with Escape counts as "spring over"', async () => {
    setupFirstVisit();
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });

    expect(screen.queryByRole('dialog', { name: 'Sådan fungerer OS2taletiltekst' })).toBeNull();
    expect(postedBodies()).toEqual([{ action: 'skip-tour' }]);
  });

  it('closing by clicking the backdrop counts as "spring over"', async () => {
    setupFirstVisit();
    // Radix arms its outside-pointer listener on the next tick.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      fireEvent.pointerDown(document.body);
    });

    expect(screen.queryByRole('dialog', { name: 'Sådan fungerer OS2taletiltekst' })).toBeNull();
    expect(postedBodies()).toEqual([{ action: 'skip-tour' }]);
  });
});

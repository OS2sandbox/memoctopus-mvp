// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { useOnboarding } from '@/lib/onboarding/context';
import { renderWithOnboarding } from '@/test/onboarding';
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

describe('WelcomeTour', () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    cleanup();
    fetchMock.mockClear();
    vi.unstubAllGlobals();
  });

  it('"kom i gang" resets seen hints and tells the server', () => {
    setup();
    expect(screen.getByTestId('seen').textContent).toBe('seen');
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('kom i gang'));

    expect(screen.getByTestId('seen').textContent).toBe('unseen');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/onboarding/step',
      expect.objectContaining({ body: JSON.stringify({ action: 'reset-hints' }) }),
    );
  });

  it('"spring over" keeps seen hints', () => {
    setup();
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('spring over'));

    expect(screen.getByTestId('seen').textContent).toBe('seen');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/onboarding/step',
      expect.objectContaining({ body: JSON.stringify({ action: 'skip-tour' }) }),
    );
  });
});

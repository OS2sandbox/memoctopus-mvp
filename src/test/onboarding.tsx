import React from 'react';
import { render } from '@testing-library/react';
import { OnboardingProvider, type OnboardingInitialState } from '@/lib/onboarding/context';

// Kept out of helpers.ts (plain Node helpers, imported by non-DOM API route tests
// too) so importing this doesn't pull @testing-library/react/React into suites
// that never render anything.

/** Marks nothing seen and lets the welcome dialog/hints behave as for a fresh user. */
export const FRESH_ONBOARDING: OnboardingInitialState = {
  tourSkipped: false,
  tourCompleted: false,
  seen: [],
};

/**
 * Renders `ui` under an OnboardingProvider. Most component suites want every
 * onboarding hint already suppressed (mirroring the real app, which mounts
 * them under the app-level OnboardingProvider well past first use) — pass the
 * step ids under test as `seen` to keep DOM queries targeting the underlying
 * controls instead of a popover.
 */
export function renderWithOnboarding(
  ui: React.ReactElement,
  initial: OnboardingInitialState = { tourSkipped: true, tourCompleted: true, seen: [] },
) {
  return render(<OnboardingProvider initial={initial}>{ui}</OnboardingProvider>);
}

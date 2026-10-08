// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImportSkabelonPage from './page';
import { getStep } from '@/lib/onboarding/steps';
import { tabTo } from '@/test/keyboard';
import { renderWithOnboarding } from '@/test/onboarding';

vi.mock('next/navigation', () => ({
  useParams: () => ({ token: 'tok-1' }),
  useRouter: () => ({ push: vi.fn() }),
}));

// The explainer hint wraps the heading; mark it seen so only the tooltip is under test.
function render(ui: React.ReactElement) {
  return renderWithOnboarding(ui, {
    tourSkipped: true,
    tourCompleted: true,
    seen: [{ stepId: 'skabelon-import.explainer', meetingId: null }],
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Delingslink er ugyldigt' }) }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ImportSkabelonPage — error next steps', () => {
  it('opens the tooltip when Tab reaches the error and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<ImportSkabelonPage />);

    const error = await screen.findByText('Delingslink er ugyldigt');
    await tabTo(user, error);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      getStep('skabelon-import.error-next-steps').copy,
    );

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});

// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewAudioProvider, useReviewAudio } from './review-audio-context';

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

/** Renders the current hasAudio value so tests can assert it via the DOM. */
function DisplayConsumer() {
  const { hasAudio } = useReviewAudio();
  return <span data-testid="has-audio">{String(hasAudio)}</span>;
}

/** Renders a button that sets hasAudio to true. */
function SetTrueConsumer() {
  const { setHasAudio } = useReviewAudio();
  return <button onClick={() => setHasAudio(true)}>set-true</button>;
}

/** Renders a button that sets hasAudio to false. */
function SetFalseConsumer() {
  const { setHasAudio } = useReviewAudio();
  return <button onClick={() => setHasAudio(false)}>set-false</button>;
}

/** Renders a button that toggles hasAudio using the current value. */
function ToggleConsumer() {
  const { hasAudio, setHasAudio } = useReviewAudio();
  return (
    <button onClick={() => setHasAudio(!hasAudio)}>toggle</button>
  );
}

// ---------------------------------------------------------------------------
// useReviewAudio — outside provider (default context value)
// ---------------------------------------------------------------------------

describe('useReviewAudio — outside a provider', () => {
  it('returns hasAudio=false when used without a provider', () => {
    render(<DisplayConsumer />);
    expect(screen.getByTestId('has-audio').textContent).toBe('false');
  });

  it('setHasAudio is a no-op when called outside a provider (does not throw)', async () => {
    const user = userEvent.setup();
    // Should not throw; the default context setHasAudio is () => {}
    render(<SetTrueConsumer />);
    await user.click(screen.getByRole('button', { name: 'set-true' }));
    // After calling the no-op setter, the displayed value remains false
    render(<DisplayConsumer />);
    expect(screen.getAllByTestId('has-audio')[0].textContent).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// ReviewAudioProvider — initial state
// ---------------------------------------------------------------------------

describe('ReviewAudioProvider — initial state', () => {
  it('provides hasAudio=false by default', () => {
    render(
      <ReviewAudioProvider>
        <DisplayConsumer />
      </ReviewAudioProvider>,
    );
    expect(screen.getByTestId('has-audio').textContent).toBe('false');
  });

  it('renders children', () => {
    render(
      <ReviewAudioProvider>
        <span data-testid="child">hello</span>
      </ReviewAudioProvider>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ReviewAudioProvider — setHasAudio updates consumers
// ---------------------------------------------------------------------------

describe('ReviewAudioProvider — setHasAudio updates value', () => {
  it('updates hasAudio to true when setHasAudio(true) is called', async () => {
    const user = userEvent.setup();
    render(
      <ReviewAudioProvider>
        <DisplayConsumer />
        <SetTrueConsumer />
      </ReviewAudioProvider>,
    );
    expect(screen.getByTestId('has-audio').textContent).toBe('false');
    await user.click(screen.getByRole('button', { name: 'set-true' }));
    expect(screen.getByTestId('has-audio').textContent).toBe('true');
  });

  it('updates hasAudio back to false after setHasAudio(false)', async () => {
    const user = userEvent.setup();
    render(
      <ReviewAudioProvider>
        <DisplayConsumer />
        <SetTrueConsumer />
        <SetFalseConsumer />
      </ReviewAudioProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'set-true' }));
    expect(screen.getByTestId('has-audio').textContent).toBe('true');
    await user.click(screen.getByRole('button', { name: 'set-false' }));
    expect(screen.getByTestId('has-audio').textContent).toBe('false');
  });

  it('toggle: hasAudio flips between false and true on repeated calls', async () => {
    const user = userEvent.setup();
    render(
      <ReviewAudioProvider>
        <DisplayConsumer />
        <ToggleConsumer />
      </ReviewAudioProvider>,
    );
    expect(screen.getByTestId('has-audio').textContent).toBe('false');
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('has-audio').textContent).toBe('true');
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('has-audio').textContent).toBe('false');
  });

  it('setting the same value twice is idempotent', async () => {
    const user = userEvent.setup();
    render(
      <ReviewAudioProvider>
        <DisplayConsumer />
        <SetTrueConsumer />
      </ReviewAudioProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'set-true' }));
    await user.click(screen.getByRole('button', { name: 'set-true' }));
    expect(screen.getByTestId('has-audio').textContent).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// ReviewAudioProvider — shared state across multiple consumers
// ---------------------------------------------------------------------------

describe('ReviewAudioProvider — multiple consumers share the same state', () => {
  /** Two independent display consumers + one setter; both should reflect the update. */
  function MultiConsumerTree() {
    return (
      <ReviewAudioProvider>
        <DisplayConsumer />
        <span data-testid="second-consumer">
          {/* A second independent hook invocation */}
          <SecondDisplay />
        </span>
        <SetTrueConsumer />
      </ReviewAudioProvider>
    );
  }

  function SecondDisplay() {
    const { hasAudio } = useReviewAudio();
    return <span data-testid="has-audio-2">{String(hasAudio)}</span>;
  }

  it('all consumers start with hasAudio=false', () => {
    render(<MultiConsumerTree />);
    expect(screen.getByTestId('has-audio').textContent).toBe('false');
    expect(screen.getByTestId('has-audio-2').textContent).toBe('false');
  });

  it('all consumers update when any one of them calls setHasAudio', async () => {
    const user = userEvent.setup();
    render(<MultiConsumerTree />);
    await user.click(screen.getByRole('button', { name: 'set-true' }));
    expect(screen.getByTestId('has-audio').textContent).toBe('true');
    expect(screen.getByTestId('has-audio-2').textContent).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// ReviewAudioProvider — nested providers are independent
// ---------------------------------------------------------------------------

describe('ReviewAudioProvider — nested providers have independent state', () => {
  function InnerDisplay() {
    const { hasAudio } = useReviewAudio();
    return <span data-testid="inner-has-audio">{String(hasAudio)}</span>;
  }

  function InnerSetTrue() {
    const { setHasAudio } = useReviewAudio();
    return <button onClick={() => setHasAudio(true)}>inner-set-true</button>;
  }

  it('inner provider state does not affect outer provider state', async () => {
    const user = userEvent.setup();
    render(
      <ReviewAudioProvider>
        <DisplayConsumer />
        <ReviewAudioProvider>
          <InnerDisplay />
          <InnerSetTrue />
        </ReviewAudioProvider>
      </ReviewAudioProvider>,
    );
    // Both start as false
    expect(screen.getByTestId('has-audio').textContent).toBe('false');
    expect(screen.getByTestId('inner-has-audio').textContent).toBe('false');

    // Updating inner provider only changes the inner consumer
    await user.click(screen.getByRole('button', { name: 'inner-set-true' }));
    expect(screen.getByTestId('inner-has-audio').textContent).toBe('true');
    expect(screen.getByTestId('has-audio').textContent).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// act() — programmatic state changes via act
// ---------------------------------------------------------------------------

describe('ReviewAudioProvider — programmatic updates via act', () => {
  it('state change triggered via act reflects immediately', async () => {
    let capturedSetHasAudio: (v: boolean) => void = () => {};

    function CaptureRef() {
      const { hasAudio, setHasAudio } = useReviewAudio();
      capturedSetHasAudio = setHasAudio;
      return <span data-testid="val">{String(hasAudio)}</span>;
    }

    render(
      <ReviewAudioProvider>
        <CaptureRef />
      </ReviewAudioProvider>,
    );

    expect(screen.getByTestId('val').textContent).toBe('false');

    act(() => {
      capturedSetHasAudio(true);
    });

    expect(screen.getByTestId('val').textContent).toBe('true');
  });
});

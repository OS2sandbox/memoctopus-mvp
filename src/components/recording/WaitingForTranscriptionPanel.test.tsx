// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WaitingForTranscriptionPanel } from './WaitingForTranscriptionPanel';

const base = { total: 3, waiting: 1, online: true, authRequired: false, persistFailed: false, onRetry: () => {} };

describe('WaitingForTranscriptionPanel', () => {
  it('shows how many parts are transcribed', () => {
    render(<WaitingForTranscriptionPanel {...base} />);
    expect(screen.getByRole('status')).toHaveTextContent('transskriberer 2 / 3 dele…');
    expect(screen.queryByText(/online igen/)).toBeNull();
  });

  it('says what is missing and that it is sent once online again', () => {
    render(<WaitingForTranscriptionPanel {...base} online={false} />);
    expect(screen.getByText(/1 af 3 dele mangler at blive transskriberet/)).toBeInTheDocument();
    expect(screen.getByText(/gemmes lyden i browseren i op til 24 timer/)).toBeInTheDocument();
  });

  it('asks to keep the tab open when the browser could not store the audio', () => {
    render(<WaitingForTranscriptionPanel {...base} online={false} persistFailed />);
    expect(screen.getByText(/Hold fanen åben/)).toBeInTheDocument();
    expect(screen.queryByText(/i op til 24 timer/)).toBeNull();
  });

  it('asks to sign in again and retries on request', () => {
    const onRetry = vi.fn();
    render(<WaitingForTranscriptionPanel {...base} authRequired onRetry={onRetry} />);
    expect(screen.getByText(/Du er blevet logget ud/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'prøv igen' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

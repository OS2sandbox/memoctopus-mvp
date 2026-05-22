// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SaveStatus } from './SaveStatus';

describe('SaveStatus', () => {
  it('renders nothing when state is idle', () => {
    const { container } = render(<SaveStatus state="idle" />);
    expect(container.firstChild).toBeNull();
  });

  it('shows "Gemmer…" when state is saving', () => {
    render(<SaveStatus state="saving" />);
    expect(screen.getByText('Gemmer…')).toBeInTheDocument();
  });

  it('shows "Gemt" when state is saved (just saved)', () => {
    render(<SaveStatus state="saved" />);
    expect(screen.getByText('Gemt')).toBeInTheDocument();
  });

  it('shows "Fejl ved gemning" when state is error', () => {
    render(<SaveStatus state="error" />);
    expect(screen.getByText('Fejl ved gemning')).toBeInTheDocument();
  });

  it('applies a custom className', () => {
    const { container } = render(<SaveStatus state="saving" className="extra-class" />);
    expect(container.firstChild).toHaveClass('extra-class');
  });

  it('applies muted color when saving', () => {
    const { container } = render(<SaveStatus state="saving" />);
    expect(container.firstChild).toHaveClass('text-[var(--muted)]');
  });

  it('applies muted color when saved', () => {
    const { container } = render(<SaveStatus state="saved" />);
    expect(container.firstChild).toHaveClass('text-[var(--muted)]');
  });

  it('applies danger color when error', () => {
    const { container } = render(<SaveStatus state="error" />);
    expect(container.firstChild).toHaveClass('text-[var(--danger)]');
  });

  it('renders no spinner for any state', () => {
    for (const state of ['saving', 'saved', 'error'] as const) {
      const { container } = render(<SaveStatus state={state} />);
      expect(container.querySelector('.animate-spin')).toBeNull();
    }
  });

  it('renders no SVG icons', () => {
    for (const state of ['saving', 'saved', 'error'] as const) {
      const { container } = render(<SaveStatus state={state} />);
      expect(container.querySelector('svg')).toBeNull();
    }
  });
});

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SaveStatus } from './SaveStatus';

describe('SaveStatus', () => {
  it('renders nothing when state is idle', () => {
    const { container } = render(<SaveStatus state="idle" />);
    expect(container.firstChild).toBeNull();
  });

  it('shows "Gemmer..." when state is saving', () => {
    render(<SaveStatus state="saving" />);
    expect(screen.getByText('Gemmer...')).toBeInTheDocument();
  });

  it('shows a spinner icon when saving', () => {
    const { container } = render(<SaveStatus state="saving" />);
    const spinner = container.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('shows "Gemt" when state is saved', () => {
    render(<SaveStatus state="saved" />);
    expect(screen.getByText('Gemt')).toBeInTheDocument();
  });

  it('shows a checkmark SVG when saved', () => {
    const { container } = render(<SaveStatus state="saved" />);
    // Checkmark path has d="M2 6l3 3 5-5"
    const path = container.querySelector('path[d="M2 6l3 3 5-5"]');
    expect(path).toBeInTheDocument();
  });

  it('shows "Fejl ved gemning" when state is error', () => {
    render(<SaveStatus state="error" />);
    expect(screen.getByText('Fejl ved gemning')).toBeInTheDocument();
  });

  it('shows a warning icon (circle + exclamation) when error', () => {
    const { container } = render(<SaveStatus state="error" />);
    const circle = container.querySelector('circle');
    expect(circle).toBeInTheDocument();
  });

  it('does not show a spinner when saved', () => {
    const { container } = render(<SaveStatus state="saved" />);
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('does not show a spinner when error', () => {
    const { container } = render(<SaveStatus state="error" />);
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('applies a custom className', () => {
    const { container } = render(<SaveStatus state="saving" className="extra-class" />);
    expect(container.firstChild).toHaveClass('extra-class');
  });

  it('applies the muted color class when saving', () => {
    const { container } = render(<SaveStatus state="saving" />);
    expect(container.firstChild).toHaveClass('text-[var(--text-muted)]');
  });

  it('applies the success color class when saved', () => {
    const { container } = render(<SaveStatus state="saved" />);
    expect(container.firstChild).toHaveClass('text-[var(--success)]');
  });

  it('applies the danger color class when error', () => {
    const { container } = render(<SaveStatus state="error" />);
    expect(container.firstChild).toHaveClass('text-[var(--danger)]');
  });
});

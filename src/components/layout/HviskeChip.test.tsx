// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HviskeChip } from './HviskeChip';

describe('HviskeChip', () => {
  it('renders the default label "Hviske" when no label prop is given', () => {
    render(<HviskeChip />);
    expect(screen.getByText('Hviske')).toBeInTheDocument();
  });

  it('renders a custom label when the label prop is provided', () => {
    render(<HviskeChip label="Custom Label" />);
    expect(screen.getByText('Custom Label')).toBeInTheDocument();
    expect(screen.queryByText('Hviske')).toBeNull();
  });

  it('renders an empty string label when explicitly passed', () => {
    const { container } = render(<HviskeChip label="" />);
    // The label span should exist but contain no text content
    const labelSpan = container.querySelector('.text-\\[var\\(--ink-2\\)\\]');
    expect(labelSpan).toBeInTheDocument();
    expect(labelSpan?.textContent).toBe('');
  });

  it('merges a custom className onto the root chip element', () => {
    const { container } = render(<HviskeChip className="my-custom-class" />);
    expect(container.firstChild).toHaveClass('my-custom-class');
  });

  it('retains the base classes when a custom className is provided', () => {
    const { container } = render(<HviskeChip className="extra" />);
    const chip = container.firstChild as HTMLElement;
    expect(chip).toHaveClass('inline-flex');
    expect(chip).toHaveClass('items-center');
    expect(chip).toHaveClass('extra');
  });

  it('renders the pulsing status dot as aria-hidden', () => {
    const { container } = render(<HviskeChip />);
    const dot = container.querySelector('[aria-hidden]');
    expect(dot).toBeInTheDocument();
  });

  it('status dot has aria-hidden set to true', () => {
    const { container } = render(<HviskeChip />);
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot).toBeInTheDocument();
  });

  it('status dot is a span with the expected shape classes', () => {
    const { container } = render(<HviskeChip />);
    const dot = container.querySelector('[aria-hidden]');
    expect(dot?.tagName).toBe('SPAN');
    expect(dot).toHaveClass('rounded-full');
    expect(dot).toHaveClass('h-1.5');
    expect(dot).toHaveClass('w-1.5');
  });

  it('status dot has an animation inline style', () => {
    const { container } = render(<HviskeChip />);
    const dot = container.querySelector('[aria-hidden]') as HTMLElement | null;
    expect(dot?.style.animation).toContain('mo-pulse');
  });

  it('root element is a <span>', () => {
    const { container } = render(<HviskeChip />);
    expect(container.firstChild?.nodeName).toBe('SPAN');
  });

  it('applies mono font family via inline style on the root', () => {
    const { container } = render(<HviskeChip />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.fontFamily).toContain('var(--font-mono)');
  });

  it('applies 11px font size via inline style on the root', () => {
    const { container } = render(<HviskeChip />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.fontSize).toBe('11px');
  });

  it('renders exactly one aria-hidden element (the dot)', () => {
    const { container } = render(<HviskeChip />);
    const hiddenEls = container.querySelectorAll('[aria-hidden]');
    expect(hiddenEls).toHaveLength(1);
  });

  it('renders a <style> tag containing the mo-pulse keyframe', () => {
    const { container } = render(<HviskeChip />);
    const style = container.querySelector('style');
    expect(style).toBeInTheDocument();
    expect(style?.textContent).toContain('mo-pulse');
  });

  it('does not render any SVG icons', () => {
    const { container } = render(<HviskeChip />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('label text is inside a <span> element', () => {
    render(<HviskeChip label="Test" />);
    const labelEl = screen.getByText('Test');
    expect(labelEl.tagName).toBe('SPAN');
  });

  it('label span does not have aria-hidden', () => {
    render(<HviskeChip label="Hviske" />);
    const labelEl = screen.getByText('Hviske');
    expect(labelEl).not.toHaveAttribute('aria-hidden');
  });
});

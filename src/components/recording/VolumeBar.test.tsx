// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VolumeBar } from './VolumeBar';

function getBars(container: HTMLElement) {
  // VolumeBar renders <div aria-label="..."> containing <span> bar elements
  const wrapper = container.querySelector('div[aria-label]');
  return wrapper ? Array.from(wrapper.querySelectorAll<HTMLElement>('span')) : [];
}

describe('VolumeBar', () => {
  it('renders 20 bars by default', () => {
    const { container } = render(<VolumeBar level={0.5} />);
    expect(getBars(container)).toHaveLength(20);
  });

  it('renders the specified number of bars', () => {
    const { container } = render(<VolumeBar level={0.5} barCount={10} />);
    expect(getBars(container)).toHaveLength(10);
  });

  it('has an aria-label reflecting the level percentage', () => {
    render(<VolumeBar level={0.75} />);
    expect(screen.getByLabelText('Lydniveau: 75%')).toBeInTheDocument();
  });

  it('shows 0% in aria-label for level 0', () => {
    render(<VolumeBar level={0} />);
    expect(screen.getByLabelText('Lydniveau: 0%')).toBeInTheDocument();
  });

  it('shows 100% in aria-label for level 1', () => {
    render(<VolumeBar level={1} />);
    expect(screen.getByLabelText('Lydniveau: 100%')).toBeInTheDocument();
  });

  it('marks no bars active at level 0', () => {
    const { container } = render(<VolumeBar level={0} />);
    const bars = getBars(container);
    expect(bars).toHaveLength(20);
    const activeBars = bars.filter((b) => parseFloat(b.style.opacity) === 1);
    expect(activeBars).toHaveLength(0);
  });

  it('marks all bars active at level 1', () => {
    const { container } = render(<VolumeBar level={1} />);
    const bars = getBars(container);
    expect(bars).toHaveLength(20);
    const activeBars = bars.filter((b) => parseFloat(b.style.opacity) === 1);
    expect(activeBars).toHaveLength(20);
  });

  it('marks roughly half bars active at level 0.5', () => {
    const { container } = render(<VolumeBar level={0.5} />);
    const bars = getBars(container);
    const activeBars = bars.filter((b) => parseFloat(b.style.opacity) === 1);
    expect(activeBars).toHaveLength(10); // Math.round(0.5 * 20) = 10
  });

  it('inactive bars have 0.5 opacity', () => {
    const { container } = render(<VolumeBar level={0} />);
    getBars(container).forEach((b) => {
      expect(parseFloat(b.style.opacity)).toBe(0.5);
    });
  });

  it('active bars have full opacity', () => {
    const { container } = render(<VolumeBar level={1} />);
    getBars(container).forEach((b) => {
      expect(parseFloat(b.style.opacity)).toBe(1);
    });
  });

  it('inactive bars use the border-strong CSS variable for color', () => {
    const { container } = render(<VolumeBar level={0} />);
    getBars(container).forEach((b) => {
      expect(b.style.backgroundColor).toBe('var(--border-strong)');
    });
  });

  it('active bars use the accent CSS variable for color', () => {
    const { container } = render(<VolumeBar level={1} />);
    getBars(container).forEach((b) => {
      expect(b.style.backgroundColor).toBe('var(--accent)');
    });
  });

  it('bar heights are clamped between 15% and 100%', () => {
    const { container } = render(<VolumeBar level={0.5} />);
    getBars(container).forEach((b) => {
      const val = parseFloat(b.style.height);
      expect(val).toBeGreaterThanOrEqual(15);
      expect(val).toBeLessThanOrEqual(100);
    });
  });

  it('each bar has a width of 3px', () => {
    const { container } = render(<VolumeBar level={0.5} />);
    getBars(container).forEach((b) => {
      expect(b.style.width).toBe('3px');
    });
  });
});

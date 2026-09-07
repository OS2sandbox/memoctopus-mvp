// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LogoMark } from './logo-mark';

function getSvg(container: HTMLElement) {
  return container.querySelector('svg')!;
}

function getCircles(container: HTMLElement) {
  return Array.from(container.querySelectorAll<SVGCircleElement>('svg circle'));
}

describe('LogoMark', () => {
  // ── Size prop ──────────────────────────────────────────────────────────────

  it('uses the default size of 40 when no size prop is given', () => {
    const { container } = render(<LogoMark />);
    const svg = getSvg(container);
    expect(svg.getAttribute('width')).toBe('40');
    expect(svg.getAttribute('height')).toBe('40');
  });

  it('applies a custom size to both width and height', () => {
    const { container } = render(<LogoMark size={64} />);
    const svg = getSvg(container);
    expect(svg.getAttribute('width')).toBe('64');
    expect(svg.getAttribute('height')).toBe('64');
  });

  it('applies a small size correctly', () => {
    const { container } = render(<LogoMark size={16} />);
    const svg = getSvg(container);
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
  });

  it('applies a large size correctly', () => {
    const { container } = render(<LogoMark size={200} />);
    const svg = getSvg(container);
    expect(svg.getAttribute('width')).toBe('200');
    expect(svg.getAttribute('height')).toBe('200');
  });

  // ── viewBox is always fixed ────────────────────────────────────────────────

  it('always uses the 0 0 32 32 viewBox regardless of size', () => {
    const { container: c1 } = render(<LogoMark size={16} />);
    expect(getSvg(c1).getAttribute('viewBox')).toBe('0 0 32 32');

    const { container: c2 } = render(<LogoMark size={200} />);
    expect(getSvg(c2).getAttribute('viewBox')).toBe('0 0 32 32');
  });

  // ── Accessibility ──────────────────────────────────────────────────────────

  it('has aria-hidden so assistive tech ignores it', () => {
    const { container } = render(<LogoMark />);
    const svg = getSvg(container);
    // aria-hidden="true" is rendered as the string "true"
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('does not render a title or desc element (purely decorative)', () => {
    const { container } = render(<LogoMark />);
    expect(container.querySelector('title')).toBeNull();
    expect(container.querySelector('desc')).toBeNull();
  });

  // ── Circle counts ──────────────────────────────────────────────────────────

  it('renders exactly 17 circles in total', () => {
    // 1 centre ring + 8 orbit mask circles + 1 red top dot + 7 white dots = 17
    const { container } = render(<LogoMark />);
    expect(getCircles(container)).toHaveLength(17);
  });

  it('renders 8 orbit-mask circles (fill #1535EB)', () => {
    const { container } = render(<LogoMark />);
    const orbitCircles = getCircles(container).filter(
      (c) => c.getAttribute('fill') === '#1535EB' && c.getAttribute('r') === '2.2',
    );
    expect(orbitCircles).toHaveLength(8);
  });

  it('renders 7 white dot circles', () => {
    const { container } = render(<LogoMark />);
    const whiteDots = getCircles(container).filter(
      (c) => c.getAttribute('fill') === '#fff' && c.getAttribute('r') === '1.5',
    );
    expect(whiteDots).toHaveLength(7);
  });

  it('renders exactly 1 red top dot', () => {
    const { container } = render(<LogoMark />);
    const redDots = getCircles(container).filter(
      (c) => c.getAttribute('fill') === '#E8304A',
    );
    expect(redDots).toHaveLength(1);
    // It sits at the top-centre position
    const redDot = redDots[0];
    expect(redDot.getAttribute('cx')).toBe('16');
    expect(redDot.getAttribute('cy')).toBe('7');
    expect(redDot.getAttribute('r')).toBe('1.5');
  });

  it('renders 1 centre ring (stroke white, no fill)', () => {
    const { container } = render(<LogoMark />);
    const centreRing = getCircles(container).filter(
      (c) =>
        c.getAttribute('fill') === 'none' &&
        c.getAttribute('stroke') === '#fff',
    );
    expect(centreRing).toHaveLength(1);
    const ring = centreRing[0];
    expect(ring.getAttribute('cx')).toBe('16');
    expect(ring.getAttribute('cy')).toBe('16');
    expect(ring.getAttribute('r')).toBe('5');
    // JSdom serialises camelCase SVG props as the hyphenated attribute name
    expect(ring.getAttribute('stroke-width')).toBe('3');
  });

  // ── Background rect ────────────────────────────────────────────────────────

  it('renders a background rect with the brand blue fill', () => {
    const { container } = render(<LogoMark />);
    const rect = container.querySelector<SVGRectElement>('svg rect');
    expect(rect).not.toBeNull();
    expect(rect!.getAttribute('fill')).toBe('#1535EB');
    expect(rect!.getAttribute('rx')).toBe('7');
    expect(rect!.getAttribute('width')).toBe('32');
    expect(rect!.getAttribute('height')).toBe('32');
  });

  // ── Inline styles ──────────────────────────────────────────────────────────

  it('applies display:block and flexShrink:0 styles to prevent layout quirks', () => {
    const { container } = render(<LogoMark />);
    const svg = getSvg(container) as SVGSVGElement & { style: CSSStyleDeclaration };
    expect(svg.style.display).toBe('block');
    expect(svg.style.flexShrink).toBe('0');
  });
});

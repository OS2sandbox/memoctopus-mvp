import { describe, it, expect } from 'vitest';
import { minutesToBody } from './minutes-format';

describe('minutesToBody', () => {
  it('returns the body directly when present', () => {
    expect(minutesToBody({ body: '## Referat\n\nHej' })).toBe('## Referat\n\nHej');
  });

  it('prefers an empty body string over legacy sections', () => {
    expect(minutesToBody({ body: '', sections: [{ key: 'k', label: 'L', content: 'C' }] })).toBe('');
  });

  it('flattens legacy sections into a single markdown document', () => {
    const out = minutesToBody({
      sections: [
        { key: 'deltagere', label: 'Deltagere', content: '- Anna\n- Bjørn' },
        { key: 'beslutninger', label: 'Beslutninger', content: 'Gå videre.' },
      ],
    });
    expect(out).toBe('## Deltagere\n\n- Anna\n- Bjørn\n\n## Beslutninger\n\nGå videre.');
  });

  it('drops empty legacy sections', () => {
    const out = minutesToBody({
      sections: [
        { key: 'a', label: 'A', content: 'x' },
        { key: 'b', label: 'B', content: '   ' },
      ],
    });
    expect(out).toBe('## A\n\nx');
  });

  it('returns an empty string for null/empty content', () => {
    expect(minutesToBody(null)).toBe('');
    expect(minutesToBody({})).toBe('');
    expect(minutesToBody({ sections: [] })).toBe('');
  });
});

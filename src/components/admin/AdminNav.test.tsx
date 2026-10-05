// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let mockPathname = '/admin';
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { AdminNav } from './AdminNav';

const SECTIONS = [
  { key: 'overview', href: '/admin', label: 'Overblik' },
  { key: 'users', href: '/admin/brugere', label: 'Brugere og roller' },
  { key: 'organisation', href: '/admin/organisation', label: 'Organisation' },
];

describe('AdminNav', () => {
  it('renders exactly the sections it is given', () => {
    mockPathname = '/admin';
    render(<AdminNav sections={[SECTIONS[0], SECTIONS[2]]} />);
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Overblik', 'Organisation']);
    expect(screen.queryByRole('link', { name: 'Brugere og roller' })).toBeNull();
  });

  it('marks only the overview current on /admin', () => {
    mockPathname = '/admin';
    render(<AdminNav sections={SECTIONS} />);
    expect(screen.getByRole('link', { name: 'Overblik' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Organisation' })).not.toHaveAttribute('aria-current');
  });

  it('marks a section current by prefix', () => {
    mockPathname = '/admin/brugere';
    render(<AdminNav sections={SECTIONS} />);
    expect(screen.getByRole('link', { name: 'Brugere og roller' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overblik' })).not.toHaveAttribute('aria-current');
  });
});

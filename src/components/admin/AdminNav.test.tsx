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

const USERS = { key: 'users', href: '/admin/brugere', label: 'Brugere og roller' };
const TEMPLATES = { key: 'templates', href: '/admin/skabeloner', label: 'Centrale skabeloner' };
const LOG = { key: 'log', href: '/admin/log', label: 'Log' };

describe('AdminNav', () => {
  it('renders exactly the sections it is given', () => {
    mockPathname = '/admin/brugere';
    render(<AdminNav sections={[USERS, TEMPLATES]} />);
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Brugere og roller', 'Centrale skabeloner']);
    expect(screen.queryByRole('link', { name: 'Overblik' })).toBeNull();
  });

  it.each([
    ['a template manager only', [TEMPLATES], ['Centrale skabeloner']],
    ['a log reader only', [LOG], ['Log']],
    ['an administrator', [USERS, TEMPLATES, LOG], ['Brugere og roller', 'Centrale skabeloner', 'Log']],
  ])('shows a tab bar for %s', (_label, sections, labels) => {
    mockPathname = sections[0].href;
    render(<AdminNav sections={sections} />);
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(labels);
    expect(screen.getByRole('link', { name: labels[0] })).toHaveAttribute('aria-current', 'page');
  });

  it('marks a section current by prefix and no other', () => {
    mockPathname = '/admin/brugere';
    render(<AdminNav sections={[USERS, TEMPLATES]} />);
    expect(screen.getByRole('link', { name: 'Brugere og roller' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Centrale skabeloner' })).not.toHaveAttribute('aria-current');
  });
});

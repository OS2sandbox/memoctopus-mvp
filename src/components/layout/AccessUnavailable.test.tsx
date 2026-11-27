// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/auth-client', () => ({ signOut: vi.fn().mockResolvedValue(undefined) }));

import { AccessUnavailable } from './AccessUnavailable';
import { signOut } from '@/lib/auth-client';

const reload = vi.fn();
const assign = vi.fn();

beforeEach(() => {
  vi.mocked(signOut).mockClear();
  reload.mockClear();
  assign.mockClear();
  vi.stubGlobal('location', { reload, assign });
});
afterEach(() => vi.unstubAllGlobals());

describe('AccessUnavailable', () => {
  it('explains that the access check is temporarily unavailable', () => {
    render(<AccessUnavailable />);
    expect(screen.getByRole('heading')).toBeInTheDocument();
    expect(screen.getByText(/Prøv igen om lidt/)).toBeInTheDocument();
  });

  it('does not repeat the heading as the body, and points to the administrator', () => {
    render(<AccessUnavailable />);
    const heading = screen.getByRole('heading').textContent;
    const body = screen.getByText(/Prøv igen om lidt/).textContent;
    expect(body).not.toContain(heading);
    expect(body).toMatch(/kontakt din administrator/);
  });

  it('is its own <main> standalone, and a plain block inside the app shell (embedded)', () => {
    const { container, rerender } = render(<AccessUnavailable />);
    expect(container.querySelector('main')).not.toBeNull();
    rerender(<AccessUnavailable embedded />);
    expect(container.querySelector('main')).toBeNull();
  });

  it('reloads the page on "Prøv igen"', async () => {
    render(<AccessUnavailable />);
    await userEvent.click(screen.getByRole('button', { name: 'Prøv igen' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('signs out and returns to / on "Log ud"', async () => {
    render(<AccessUnavailable />);
    await userEvent.click(screen.getByRole('button', { name: 'Log ud' }));
    expect(signOut).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });
});

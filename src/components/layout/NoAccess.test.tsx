// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/auth-client', () => ({ signOut: vi.fn().mockResolvedValue(undefined) }));

import { NoAccess } from './NoAccess';
import { signOut } from '@/lib/auth-client';

beforeEach(() => vi.mocked(signOut).mockClear());

describe('NoAccess', () => {
  it('explains a disabled account', () => {
    render(<NoAccess reason="disabled" />);
    expect(screen.getByRole('heading', { name: 'Ingen adgang' })).toBeInTheDocument();
    expect(screen.getByText(/deaktiveret/)).toBeInTheDocument();
  });

  it('explains a missing role', () => {
    render(<NoAccess reason="no_role" />);
    expect(screen.getByText(/ikke fået tildelt en rolle/)).toBeInTheDocument();
  });

  it('offers to sign out', async () => {
    render(<NoAccess reason="no_role" />);
    await userEvent.click(screen.getByRole('button', { name: 'Log ud' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

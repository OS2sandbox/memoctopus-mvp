import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock('@/lib/authz/page-gate', () => ({ requireAdminSection: vi.fn() }));
vi.mock('@/components/admin/AuditLog', () => ({ AuditLog: () => null }));
vi.mock('@/components/admin/UsersAdmin', () => ({ UsersAdmin: () => null }));
vi.mock('@/components/admin/CentralTemplatesAdmin', () => ({ CentralTemplatesAdmin: () => null }));

import { requireAdminSection } from '@/lib/authz/page-gate';
import BrugerePage from './brugere/page';
import LogPage from './log/page';
import OrganisationRedirectPage from './organisation/page';
import SkabelonerPage from './skabeloner/page';

const gate = vi.mocked(requireAdminSection);

beforeEach(() => {
  gate.mockReset().mockResolvedValue({} as never);
});

// Each page repeats the gate for its own section: the layout is not re-rendered
// on client-side navigation, so it cannot be the only check.
describe('admin pages gate their own section', () => {
  it.each([
    ['users', BrugerePage],
    ['templates', SkabelonerPage],
    ['log', LogPage],
  ] as const)('%s', async (key, Page) => {
    await Page();
    expect(gate).toHaveBeenCalledWith(key);
  });

  it('keeps old /admin/organisation bookmarks working with a redirect to the users page', () => {
    expect(() => OrganisationRedirectPage()).toThrow('REDIRECT:/admin/brugere');
  });

  it('does not render when the gate throws', async () => {
    gate.mockImplementation(() => {
      throw new Error('NOT_FOUND');
    });
    await expect(BrugerePage()).rejects.toThrow('NOT_FOUND');
  });
});

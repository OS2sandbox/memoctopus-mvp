import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/authz/page-gate', () => ({ requireAdminSection: vi.fn() }));
vi.mock('@/components/admin/AuditLog', () => ({ AuditLog: () => null }));
vi.mock('@/components/admin/AdminOverview', () => ({ AdminOverview: () => null }));
vi.mock('@/components/admin/UsersAdmin', () => ({ UsersAdmin: () => null }));
vi.mock('@/components/admin/OrganisationAdmin', () => ({ OrganisationAdmin: () => null }));
vi.mock('@/components/admin/CentralTemplatesAdmin', () => ({ CentralTemplatesAdmin: () => null }));

import { requireAdminSection } from '@/lib/authz/page-gate';
import AdminPage from './page';
import BrugerePage from './brugere/page';
import LogPage from './log/page';
import OrganisationPage from './organisation/page';
import SkabelonerPage from './skabeloner/page';

const gate = vi.mocked(requireAdminSection);

beforeEach(() => {
  gate.mockReset().mockResolvedValue({} as never);
});

// Each page repeats the gate for its own section: the layout is not re-rendered
// on client-side navigation, so it cannot be the only check.
describe('admin pages gate their own section', () => {
  it.each([
    ['overview', AdminPage],
    ['users', BrugerePage],
    ['organisation', OrganisationPage],
    ['templates', SkabelonerPage],
    ['log', LogPage],
  ] as const)('%s', async (key, Page) => {
    await Page();
    expect(gate).toHaveBeenCalledWith(key);
  });

  it('does not render when the gate throws', async () => {
    gate.mockImplementation(() => {
      throw new Error('NOT_FOUND');
    });
    await expect(BrugerePage()).rejects.toThrow('NOT_FOUND');
  });
});

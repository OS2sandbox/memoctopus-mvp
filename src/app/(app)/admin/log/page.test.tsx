import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/authz/page-gate', () => ({ requireAdminSection: vi.fn() }));
vi.mock('@/components/admin/AuditLog', () => ({ AuditLog: () => null }));

import { requireAdminSection } from '@/lib/authz/page-gate';
import LogPage from './page';

const gate = vi.mocked(requireAdminSection);
beforeEach(() => {
  gate.mockReset().mockResolvedValue({} as never);
});

describe('/admin/log page', () => {
  it('gates its own section', async () => {
    await LogPage();
    expect(gate).toHaveBeenCalledWith('log');
  });

  it('does not render when the gate throws', async () => {
    gate.mockImplementation(() => {
      throw new Error('NOT_FOUND');
    });
    await expect(LogPage()).rejects.toThrow('NOT_FOUND');
  });
});

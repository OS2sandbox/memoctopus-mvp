import { describe, it, expect, vi, beforeEach } from 'vitest';

// redirect()/notFound() throw in Next to halt rendering; mirror that.
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('@/lib/authz/guard', () => ({ getPrincipalForServerComponent: vi.fn() }));
vi.mock('@/lib/audit/safe-log', () => ({ safeLogError: vi.fn() }));

import AdminIndexPage from './page';
import { getPrincipalForServerComponent } from '@/lib/authz/guard';
import { FAKE_PRINCIPAL_ADMIN, makePrincipal } from '@/test/helpers';

const mockPrincipal = vi.mocked(getPrincipalForServerComponent);

beforeEach(() => mockPrincipal.mockReset());

describe('/admin index redirects to the first section the principal may open', () => {
  it.each([
    ['an administrator', FAKE_PRINCIPAL_ADMIN, '/admin/brugere'],
    ['a template manager without directory access', makePrincipal({ capabilities: ['template.use', 'template.manage'] }), '/admin/skabeloner'],
    ['a log reader without directory access', makePrincipal({ capabilities: ['template.use', 'audit.read'] }), '/admin/log'],
    ['a directory reader', makePrincipal({ capabilities: ['template.use', 'directory.read'] }), '/admin/organisation'],
    [
      'a template manager who can also read the directory',
      makePrincipal({ capabilities: ['template.use', 'template.manage', 'directory.read'] }),
      '/admin/organisation',
    ],
  ])('%s', async (_label, principal, target) => {
    mockPrincipal.mockResolvedValue(principal);
    await expect(AdminIndexPage()).rejects.toThrow(`REDIRECT:${target}`);
  });

  it('gives a user without any admin section a 404, like the layout', async () => {
    mockPrincipal.mockResolvedValue(makePrincipal());
    await expect(AdminIndexPage()).rejects.toThrow('NOT_FOUND');
  });

  it('gives a disabled administrator a 404', async () => {
    mockPrincipal.mockResolvedValue({ ...FAKE_PRINCIPAL_ADMIN, disabled: true });
    await expect(AdminIndexPage()).rejects.toThrow('NOT_FOUND');
  });

  it('sends a signed-out visitor to the landing page', async () => {
    mockPrincipal.mockResolvedValue(null);
    await expect(AdminIndexPage()).rejects.toThrow('REDIRECT:/?expired=1');
  });
});

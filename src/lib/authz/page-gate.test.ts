import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('@/lib/audit/safe-log', () => ({ safeLogError: vi.fn() }));
vi.mock('./guard', () => ({ getPrincipalForServerComponent: vi.fn() }));

import { getPrincipalForServerComponent } from './guard';
import { AccessCheckUnavailableError, requireAdminSection, requireAnyAdminSection } from './page-gate';
import { safeLogError } from '@/lib/audit/safe-log';
import { FAKE_PRINCIPAL_ADMIN, makePrincipal } from '@/test/helpers';

const mockPrincipal = vi.mocked(getPrincipalForServerComponent);

const templateManager = makePrincipal({ capabilities: ['template.use', 'template.manage'] });

beforeEach(() => {
  mockPrincipal.mockReset();
});

describe('requireAnyAdminSection', () => {
  it('redirects to / when not signed in', async () => {
    mockPrincipal.mockResolvedValue(null);
    await expect(requireAnyAdminSection()).rejects.toThrow('REDIRECT:/?expired=1');
  });

  it('404s a plain user', async () => {
    mockPrincipal.mockResolvedValue(makePrincipal());
    await expect(requireAnyAdminSection()).rejects.toThrow('NOT_FOUND');
  });

  it('404s a disabled principal even with capabilities', async () => {
    mockPrincipal.mockResolvedValue({ ...FAKE_PRINCIPAL_ADMIN, disabled: true });
    await expect(requireAnyAdminSection()).rejects.toThrow('NOT_FOUND');
  });

  it('returns the visible sections for a template manager', async () => {
    mockPrincipal.mockResolvedValue(templateManager);
    const { sections } = await requireAnyAdminSection();
    expect(sections.map((s) => s.key)).toEqual(['templates']);
  });
});

describe('requireAdminSection', () => {
  it('redirects to / when not signed in', async () => {
    mockPrincipal.mockResolvedValue(null);
    await expect(requireAdminSection('users')).rejects.toThrow('REDIRECT:/?expired=1');
  });

  it('404s a template manager on the users section', async () => {
    mockPrincipal.mockResolvedValue(templateManager);
    await expect(requireAdminSection('users')).rejects.toThrow('NOT_FOUND');
  });

  it('lets a template manager into the templates section', async () => {
    mockPrincipal.mockResolvedValue(templateManager);
    await expect(requireAdminSection('templates')).resolves.toBe(templateManager);
  });

  it('lets an administrator into the users section', async () => {
    mockPrincipal.mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
    await expect(requireAdminSection('users')).resolves.toBe(FAKE_PRINCIPAL_ADMIN);
  });
});

describe('principal lookup failure (database down)', () => {
  it.each([
    ['requireAnyAdminSection', () => requireAnyAdminSection()],
    ['requireAdminSection', () => requireAdminSection('users')],
  ] as const)('%s fails closed with a specific error and logs without the raw message', async (_n, run) => {
    vi.mocked(safeLogError).mockClear();
    mockPrincipal.mockRejectedValue(new Error('connect ECONNREFUSED postgres://user:secret@db'));
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessCheckUnavailableError);
    expect((err as Error).message).not.toContain('secret');
    expect(safeLogError).toHaveBeenCalledTimes(1);
  });

  it('does not swallow redirect/notFound signals as an unavailable access check', async () => {
    mockPrincipal.mockResolvedValue(null);
    await expect(requireAdminSection('users')).rejects.not.toBeInstanceOf(AccessCheckUnavailableError);
    mockPrincipal.mockResolvedValue(makePrincipal());
    await expect(requireAnyAdminSection()).rejects.not.toBeInstanceOf(AccessCheckUnavailableError);
  });
});

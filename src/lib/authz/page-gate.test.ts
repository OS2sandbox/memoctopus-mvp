import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('./guard', () => ({ getPrincipalForServerComponent: vi.fn() }));

import { getPrincipalForServerComponent } from './guard';
import { requireAdminSection, requireAnyAdminSection } from './page-gate';
import { FAKE_PRINCIPAL_ADMIN, makePrincipal } from '@/test/helpers';

const mockPrincipal = vi.mocked(getPrincipalForServerComponent);

const dirReader = makePrincipal({ capabilities: ['template.use', 'directory.read'] });

beforeEach(() => {
  mockPrincipal.mockReset();
});

describe('requireAnyAdminSection', () => {
  it('redirects to / when not signed in', async () => {
    mockPrincipal.mockResolvedValue(null);
    await expect(requireAnyAdminSection()).rejects.toThrow('REDIRECT:/');
  });

  it('404s a plain user', async () => {
    mockPrincipal.mockResolvedValue(makePrincipal());
    await expect(requireAnyAdminSection()).rejects.toThrow('NOT_FOUND');
  });

  it('404s a disabled principal even with capabilities', async () => {
    mockPrincipal.mockResolvedValue({ ...FAKE_PRINCIPAL_ADMIN, disabled: true });
    await expect(requireAnyAdminSection()).rejects.toThrow('NOT_FOUND');
  });

  it('returns the visible sections for a directory reader', async () => {
    mockPrincipal.mockResolvedValue(dirReader);
    const { sections } = await requireAnyAdminSection();
    expect(sections.map((s) => s.key)).toEqual(['overview', 'organisation']);
  });
});

describe('requireAdminSection', () => {
  it('redirects to / when not signed in', async () => {
    mockPrincipal.mockResolvedValue(null);
    await expect(requireAdminSection('users')).rejects.toThrow('REDIRECT:/');
  });

  it('404s a directory reader on the users section', async () => {
    mockPrincipal.mockResolvedValue(dirReader);
    await expect(requireAdminSection('users')).rejects.toThrow('NOT_FOUND');
  });

  it('lets a directory reader into the organisation section', async () => {
    mockPrincipal.mockResolvedValue(dirReader);
    await expect(requireAdminSection('organisation')).resolves.toBe(dirReader);
  });

  it('lets an administrator into the users section', async () => {
    mockPrincipal.mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
    await expect(requireAdminSection('users')).resolves.toBe(FAKE_PRINCIPAL_ADMIN);
  });
});

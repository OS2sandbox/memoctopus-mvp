import { describe, it, expect, vi, beforeEach } from 'vitest';

// redirect()/notFound() throw in Next to halt rendering; mirror that so the
// gate decision is observable as a thrown control-flow signal.
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('@/lib/authz/guard', () => ({ getPrincipalForServerComponent: vi.fn() }));
vi.mock('@/components/admin/AdminNav', () => ({ AdminNav: () => null }));

import AdminLayout from './layout';
import { getPrincipalForServerComponent } from '@/lib/authz/guard';
import { ToastProvider } from '@/components/ui/toast';
import { AdminNav } from '@/components/admin/AdminNav';
import { FAKE_PRINCIPAL_ADMIN, makePrincipal } from '@/test/helpers';

const mockPrincipal = vi.mocked(getPrincipalForServerComponent);

beforeEach(() => {
  mockPrincipal.mockReset();
});

type El = { type: unknown; props: { children?: unknown } };

function findAll(node: unknown, type: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => findAll(n, type, out));
  else if (node && typeof node === 'object' && 'props' in node) {
    const el = node as El;
    if (el.type === type) out.push(el);
    findAll(el.props.children, type, out);
  }
  return out;
}

describe('(app)/admin layout — server-side gate', () => {
  it('redirects to / when there is no session', async () => {
    mockPrincipal.mockResolvedValueOnce(null);
    await expect(AdminLayout({ children: null })).rejects.toThrow('REDIRECT:/');
  });

  it('answers 404 (not 403) for a plain user, hiding that /admin exists', async () => {
    mockPrincipal.mockResolvedValueOnce(makePrincipal());
    await expect(AdminLayout({ children: null })).rejects.toThrow('NOT_FOUND');
  });

  it('answers 404 for a disabled principal', async () => {
    mockPrincipal.mockResolvedValueOnce({ ...FAKE_PRINCIPAL_ADMIN, disabled: true });
    await expect(AdminLayout({ children: null })).rejects.toThrow('NOT_FOUND');
  });

  it('renders toasts and a nav limited to the visible sections for a directory reader', async () => {
    mockPrincipal.mockResolvedValueOnce(makePrincipal({ capabilities: ['template.use', 'directory.read'] }));
    const el = await AdminLayout({ children: 'CONTENT' });
    expect((el as unknown as El).type).toBe(ToastProvider);
    const [nav] = findAll(el, AdminNav);
    expect((nav.props as unknown as { sections: Array<{ key: string }> }).sections.map((s) => s.key)).toEqual([
      'overview',
      'organisation',
    ]);
  });

  it('gives an administrator every section', async () => {
    mockPrincipal.mockResolvedValueOnce(FAKE_PRINCIPAL_ADMIN);
    const el = await AdminLayout({ children: null });
    const [nav] = findAll(el, AdminNav);
    expect((nav.props as unknown as { sections: Array<{ key: string }> }).sections.map((s) => s.key)).toEqual([
      'overview',
      'users',
      'organisation',
    ]);
  });

  it('only passes serialisable nav fields to the client component', async () => {
    mockPrincipal.mockResolvedValueOnce(FAKE_PRINCIPAL_ADMIN);
    const el = await AdminLayout({ children: null });
    const [nav] = findAll(el, AdminNav);
    for (const s of (nav.props as unknown as { sections: object[] }).sections) {
      expect(Object.keys(s).sort()).toEqual(['href', 'key', 'label']);
    }
  });
});

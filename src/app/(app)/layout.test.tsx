import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the boundary deps so we can exercise the layout's auth gate in isolation.
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

// next/navigation's redirect() throws internally to halt rendering — mirror that
// so the "unauthenticated" path is observable as a thrown control-flow signal.
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

// The layout renders client components; stub them out — this test only cares
// about the auth decision, not the rendered tree.
vi.mock('@/components/layout/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/lib/review-audio-context', () => ({
  ReviewAudioProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import AppLayout from './layout';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { OnboardingProvider } from '@/lib/onboarding/context';

// Walk the returned element tree (nothing is rendered) to find the OnboardingProvider node.
function findOnboardingProvider(node: unknown): { props: { initial?: unknown } } | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === OnboardingProvider) return el as never;
  const kids = el.props?.children;
  for (const kid of Array.isArray(kids) ? kids : [kids]) {
    const found = findOnboardingProvider(kid);
    if (found) return found;
  }
  return null;
}

const mockGetSession = vi.mocked(auth.api.getSession);
const mockRedirect = vi.mocked(redirect);

beforeEach(() => {
  mockGetSession.mockReset();
  mockRedirect.mockClear();
});

describe('(app) layout — server-side auth gate', () => {
  it('redirects to / when there is no valid session (forged/expired/absent cookie)', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    await expect(AppLayout({ children: null })).rejects.toThrow('REDIRECT:/');
    expect(mockRedirect).toHaveBeenCalledWith('/');
  });

  it('validates the actual token via getSession, not mere cookie presence', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    await expect(AppLayout({ children: null })).rejects.toThrow();
    // The gate must consult getSession (which checks the token against the DB),
    // which is the whole point — a present-but-invalid cookie must not pass.
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it('renders the authenticated shell when the session is valid', async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: 'u1' }, session: {} } as never);
    const el = await AppLayout({ children: 'CONTENT' });
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(el).toBeTruthy();
  });
});

describe('(app) layout — onboarding', () => {
  // Onboarding state is fetched client-side by OnboardingProvider itself (GET
  // /api/onboarding/state — see context.test.tsx for that behavior, including the
  // "state cannot be loaded" fallback), not read here. This layout no longer awaits
  // a DB round trip for it on every authenticated page load — it just mounts the
  // provider with no `initial`, letting it fetch its own state.
  it('mounts OnboardingProvider without an initial prop, so it fetches its own state', async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: 'u1' }, session: {} } as never);

    const el = await AppLayout({ children: 'CONTENT' });

    const provider = findOnboardingProvider(el);
    expect(provider).toBeTruthy();
    expect(provider?.props.initial).toBeUndefined();
  });
});

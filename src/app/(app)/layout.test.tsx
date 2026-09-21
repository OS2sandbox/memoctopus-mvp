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

vi.mock('@/lib/onboarding/store', () => ({
  getOnboardingState: vi.fn().mockResolvedValue({ tourSkipped: false, tourCompleted: false, lastStepId: null }),
  getSeenSteps: vi.fn().mockResolvedValue([]),
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
import { getOnboardingState, getSeenSteps } from '@/lib/onboarding/store';

// Walk the returned element tree (nothing is rendered) to the provider's props.
function providerProps(node: unknown): { initial: Record<string, unknown> } | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === OnboardingProvider) return el.props as never;
  const kids = el.props?.children;
  for (const kid of Array.isArray(kids) ? kids : [kids]) {
    const found = providerProps(kid);
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
  // The marker matters: the middleware lets a present-but-invalid cookie through
  // to here, so a bare redirect('/') would be bounced straight back by the
  // middleware's authenticated-user shortcut, looping until the browser gives up.
  it('redirects to / when there is no valid session (forged/expired/absent cookie)', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    await expect(AppLayout({ children: null })).rejects.toThrow('REDIRECT:/?session_expired=1');
    expect(mockRedirect).toHaveBeenCalledWith('/?session_expired=1');
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

describe('(app) layout — onboarding state is optional', () => {
  it('still renders the app, with onboarding switched off, when the state cannot be loaded', async () => {
    // The pages themselves are IndexedDB-based; a hiccup in the onboarding tables must
    // not turn every page, including the recording screen, into a 500.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetSession.mockResolvedValueOnce({ user: { id: 'u1' }, session: {} } as never);
    vi.mocked(getOnboardingState).mockRejectedValueOnce(new Error('db down'));

    const el = await AppLayout({ children: 'CONTENT' });

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(providerProps(el)?.initial).toMatchObject({ unavailable: true, seen: [] });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('also falls back when only the seen-steps query fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetSession.mockResolvedValueOnce({ user: { id: 'u1' }, session: {} } as never);
    vi.mocked(getSeenSteps).mockRejectedValueOnce(new Error('relation does not exist'));

    const el = await AppLayout({ children: 'CONTENT' });

    expect(providerProps(el)?.initial).toMatchObject({ unavailable: true });
    spy.mockRestore();
  });

  it('passes the real state through when loading works', async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: 'u1' }, session: {} } as never);
    vi.mocked(getSeenSteps).mockResolvedValueOnce([{ stepId: 'a.b', meetingId: null }]);

    const el = await AppLayout({ children: 'CONTENT' });

    const initial = providerProps(el)?.initial;
    expect(initial?.unavailable).toBeFalsy();
    expect(initial?.seen).toEqual([{ stepId: 'a.b', meetingId: null }]);
  });
});

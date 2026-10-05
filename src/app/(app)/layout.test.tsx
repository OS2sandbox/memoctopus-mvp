import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('@/lib/authz/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/audit/seam', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: {}, pool: {} }));
vi.mock('@/components/layout/NoAccess', () => ({ NoAccess: () => null }));

// The layout renders client components; stub them out — this test only cares
// about the auth decision, not the rendered tree.
vi.mock('@/components/layout/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/lib/review-audio-context', () => ({
  ReviewAudioProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import AppLayout from './layout';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { resolvePrincipal } from '@/lib/authz/principal';
import { recordAuthzDenied } from '@/lib/audit/seam';
import { NoAccess } from '@/components/layout/NoAccess';
import { makePrincipal } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockRedirect = vi.mocked(redirect);
const mockResolve = vi.mocked(resolvePrincipal);

beforeEach(() => {
  mockGetSession.mockReset();
  mockRedirect.mockClear();
  mockResolve.mockReset().mockResolvedValue(makePrincipal());
  vi.mocked(recordAuthzDenied).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

type El = { type: unknown; props: { children?: unknown; reason?: string } };
const signedIn = () => mockGetSession.mockResolvedValueOnce({ user: { id: 'u1' }, session: {} } as never);

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

describe('(app) layout — principal gate', () => {
  it('shows NoAccess (no app shell, no children) for a disabled directory user', async () => {
    signedIn();
    mockResolve.mockResolvedValue(makePrincipal({ disabled: true, roles: [], capabilities: [] }));
    const el = (await AppLayout({ children: 'CONTENT' })) as El;
    expect(el.type).toBe(NoAccess);
    expect(el.props.reason).toBe('disabled');
    expect(JSON.stringify(el)).not.toContain('CONTENT');
    expect(recordAuthzDenied).toHaveBeenCalledWith(expect.objectContaining({ reason: 'disabled' }));
  });

  it('refuses a user without a role when REQUIRE_ROLE_TO_LOGIN=true', async () => {
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', 'true');
    signedIn();
    mockResolve.mockResolvedValue(makePrincipal({ roles: [], capabilities: [] }));
    const el = (await AppLayout({ children: 'CONTENT' })) as El;
    expect(el.type).toBe(NoAccess);
    expect(el.props.reason).toBe('no_role');
  });

  it('lets a user without an assignment in (implicit tt-bruger) when the flag is off', async () => {
    signedIn();
    const el = (await AppLayout({ children: 'CONTENT' })) as El;
    expect(el.type).not.toBe(NoAccess);
    expect(recordAuthzDenied).not.toHaveBeenCalled();
  });

  it('lets a user with an assigned role in when the flag is on', async () => {
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', 'true');
    signedIn();
    mockResolve.mockResolvedValue(makePrincipal({ roles: ['tt-logleser'] }));
    const el = (await AppLayout({ children: 'CONTENT' })) as El;
    expect(el.type).not.toBe(NoAccess);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));
vi.mock('./principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { recordAuthzDenied } from '@/lib/audit/authz-denied';
import { FAKE_SESSION, makePrincipal } from '@/test/helpers';
import { resolvePrincipal } from './principal';
import { requireAppAccess } from './app-access';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockDenied = vi.mocked(recordAuthzDenied);

beforeEach(() => {
  mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockReset().mockResolvedValue(makePrincipal());
  mockDenied.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('requireAppAccess', () => {
  it('answers 401 without a session and never resolves the principal', async () => {
    mockGetSession.mockResolvedValue(null as never);
    const res = await requireAppAccess();
    expect(res).toBeInstanceOf(NextResponse);
    expect((res as NextResponse).status).toBe(401);
    expect(await (res as NextResponse).json()).toEqual({ error: 'Unauthorized' });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('returns the session and live principal for a normal user', async () => {
    const principal = makePrincipal();
    mockResolve.mockResolvedValue(principal);
    const res = await requireAppAccess();
    expect(res).not.toBeInstanceOf(NextResponse);
    expect(res).toEqual({ session: FAKE_SESSION, principal });
    expect(mockResolve).toHaveBeenCalledWith('user-123');
    expect(mockDenied).not.toHaveBeenCalled();
  });

  it('refuses a disabled user with 403 and records the denial', async () => {
    mockResolve.mockResolvedValue(makePrincipal({ disabled: true, roles: [], capabilities: [] }));
    const res = (await requireAppAccess()) as NextResponse;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(mockDenied).toHaveBeenCalledWith({ actorUserId: 'user-123', required: 'login', reason: 'disabled' });
  });

  it('refuses a user without a role when REQUIRE_ROLE_TO_LOGIN=true', async () => {
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', 'true');
    mockResolve.mockResolvedValue(makePrincipal({ roles: [], capabilities: [] }));
    const res = (await requireAppAccess()) as NextResponse;
    expect(res.status).toBe(403);
    expect(mockDenied).toHaveBeenCalledWith({ actorUserId: 'user-123', required: 'login', reason: 'no_role' });
  });

  it('lets a user with a role through when REQUIRE_ROLE_TO_LOGIN=true', async () => {
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', 'true');
    mockResolve.mockResolvedValue(makePrincipal({ roles: ['tt-logleser'] }));
    expect(await requireAppAccess()).not.toBeInstanceOf(NextResponse);
  });

  it('claims mode: a user the IdP mapped to no role gets 403 by default, and a mapped one gets in', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'claims');
    mockResolve.mockResolvedValue(makePrincipal({ roles: [], capabilities: [], source: 'baseline' }));
    const res = (await requireAppAccess()) as NextResponse;
    expect(res.status).toBe(403);
    expect(mockDenied).toHaveBeenCalledWith({ actorUserId: 'user-123', required: 'login', reason: 'no_role' });

    mockResolve.mockResolvedValue(makePrincipal({ roles: ['tt-bruger'], source: 'claims' }));
    expect(await requireAppAccess()).not.toBeInstanceOf(NextResponse);

    // Only an explicit opt-out opens it again.
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', 'false');
    mockResolve.mockResolvedValue(makePrincipal({ roles: [], source: 'baseline' }));
    expect(await requireAppAccess()).not.toBeInstanceOf(NextResponse);
  });

  it('lets the implicit baseline user through when the flag is off', async () => {
    mockResolve.mockResolvedValue(makePrincipal({ roles: [], source: 'baseline' }));
    expect(await requireAppAccess()).not.toBeInstanceOf(NextResponse);
    expect(mockDenied).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the principal lookup throws, logging content-free', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = Object.assign(new Error('SECRET transcript text from user@example.com'), { code: 'ECONNRESET' });
    mockResolve.mockRejectedValue(err);
    const res = await requireAppAccess();
    expect(res).toBeInstanceOf(NextResponse);
    expect((res as NextResponse).status).toBe(503);
    expect(await (res as NextResponse).json()).toEqual({ error: 'Adgangskontrol er midlertidigt utilgængelig' });
    expect(mockDenied).not.toHaveBeenCalled();
    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).toContain('name=Error');
    expect(logged).toContain('code=ECONNRESET');
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain('user@example.com');
    expect(logged).not.toContain('user-123');
  });

  it('fails closed with 503 on a ConfigError and logs only "ConfigError"', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockResolve.mockRejectedValue(
      Object.assign(new Error('ACCESS_SOURCE must be "local" or "rollekatalog"'), { name: 'ConfigError' }),
    );
    const res = (await requireAppAccess()) as NextResponse;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Adgangskontrol er midlertidigt utilgængelig' });
    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).toContain('name=ConfigError');
    expect(logged).not.toContain('ACCESS_SOURCE');
  });
});

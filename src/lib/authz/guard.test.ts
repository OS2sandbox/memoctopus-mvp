import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));
vi.mock('./principal', () => ({
  resolvePrincipal: vi.fn(),
}));
vi.mock('@/lib/audit/seam', () => ({
  recordAuthzDenied: vi.fn(),
  recordAdminAction: vi.fn(),
}));

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { recordAuthzDenied } from '@/lib/audit/seam';
import { FAKE_PRINCIPAL_ADMIN, FAKE_SESSION, makeJsonReq, NO_PARAMS, makePrincipal } from '@/test/helpers';
import { resolvePrincipal } from './principal';
import {
  getPrincipalForServerComponent,
  hasCapability,
  loginRefusal,
  notFoundOrForbidden,
  requireCapability,
  withAuthz,
} from './guard';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockResolve = vi.mocked(resolvePrincipal);
const mockDenied = vi.mocked(recordAuthzDenied);

const req = () => makeJsonReq('http://localhost/api/x', 'GET');
const ok = async () => NextResponse.json({ ok: true });

beforeEach(() => {
  mockGetSession.mockReset();
  mockResolve.mockReset();
  mockDenied.mockReset();
  mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  mockResolve.mockResolvedValue(FAKE_PRINCIPAL_ADMIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('withAuthz', () => {
  it('401 when there is no session, without resolving a principal', async () => {
    mockGetSession.mockResolvedValue(null as never);
    const res = await withAuthz('t', 'access.manage', ok)(req(), NO_PARAMS);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('403 for a disabled principal, even with a null capability, and records the denial', async () => {
    mockResolve.mockResolvedValue(makePrincipal({ disabled: true, capabilities: [] }));
    const handler = vi.fn(ok);
    const res = await withAuthz('t', null, handler)(req(), NO_PARAMS);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(handler).not.toHaveBeenCalled();
    expect(mockDenied).toHaveBeenCalledWith(expect.objectContaining({ reason: 'disabled', actorUserId: 'user-123' }));
  });

  it('403 when the capability is missing, records the denial and does not call the handler', async () => {
    mockResolve.mockResolvedValue(makePrincipal());
    const handler = vi.fn(ok);
    const res = await withAuthz('t', 'access.manage', handler)(req(), NO_PARAMS);
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(mockDenied).toHaveBeenCalledTimes(1);
    expect(mockDenied).toHaveBeenCalledWith({
      actorUserId: 'user-123',
      required: 'access.manage',
      reason: 'missing_capability',
      entityType: undefined,
      entityId: undefined,
    });
  });

  it('calls the handler with session and principal on success', async () => {
    const handler = vi.fn(ok);
    const res = await withAuthz('t', 'access.manage', handler)(req(), NO_PARAMS);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(expect.anything(), {
      session: FAKE_SESSION,
      principal: FAKE_PRINCIPAL_ADMIN,
      params: {},
    });
    expect(mockDenied).not.toHaveBeenCalled();
  });

  it('a null capability lets any signed-in, enabled user through', async () => {
    mockResolve.mockResolvedValue(makePrincipal());
    const res = await withAuthz('t', null, ok)(req(), NO_PARAMS);
    expect(res.status).toBe(200);
  });

  it('forwards the awaited Next 15 route params', async () => {
    const handler = vi.fn(async (_r, ctx: { params: { id: string } }) => NextResponse.json({ id: ctx.params.id }));
    const route = withAuthz<{ id: string }>('t', null, handler);
    const res = await route(req(), { params: Promise.resolve({ id: 'abc' }) });
    expect(await res.json()).toEqual({ id: 'abc' });
  });

  it('turns a throwing handler into the standard JSON 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await withAuthz('t', null, async () => {
      throw new Error('boom');
    })(req(), NO_PARAMS);
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect((await res.json()).error).toBeDefined();
  });

  it('turns a throwing resolvePrincipal into a JSON 500 (never an implicit allow)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockResolve.mockRejectedValue(new Error('db down'));
    const handler = vi.fn(ok);
    const res = await withAuthz('t', null, handler)(req(), NO_PARAMS);
    expect(res.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
  });

  describe('requireLocalSource', () => {
    it('409 in rollekatalog mode, after the capability check', async () => {
      vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
      const handler = vi.fn(ok);
      const res = await withAuthz('t', 'access.manage', handler, { requireLocalSource: true })(req(), NO_PARAMS);
      expect(res.status).toBe(409);
      expect(handler).not.toHaveBeenCalled();
      expect(mockDenied).toHaveBeenCalledWith(expect.objectContaining({ reason: 'wrong_source' }));
    });

    it('a caller without the capability still gets 403, not 409', async () => {
      vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
      mockResolve.mockResolvedValue(makePrincipal());
      const res = await withAuthz('t', 'access.manage', ok, { requireLocalSource: true })(req(), NO_PARAMS);
      expect(res.status).toBe(403);
    });

    it('passes in local mode', async () => {
      vi.stubEnv('ACCESS_SOURCE', 'local');
      const res = await withAuthz('t', 'access.manage', ok, { requireLocalSource: true })(req(), NO_PARAMS);
      expect(res.status).toBe(200);
    });

    it('is not enforced unless asked for', async () => {
      vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
      const res = await withAuthz('t', 'access.manage', ok)(req(), NO_PARAMS);
      expect(res.status).toBe(200);
    });
  });
});

describe('requireCapability / hasCapability', () => {
  it('null when held', () => {
    expect(requireCapability(FAKE_PRINCIPAL_ADMIN, 'sync.run')).toBeNull();
    expect(mockDenied).not.toHaveBeenCalled();
  });

  it('403 plus an id-only denial event when missing', async () => {
    const res = requireCapability(makePrincipal(), 'sync.run', { type: 'org_unit', id: 'u1' });
    expect(res?.status).toBe(403);
    expect(mockDenied).toHaveBeenCalledWith(
      expect.objectContaining({ required: 'sync.run', entityType: 'org_unit', entityId: 'u1' }),
    );
  });

  it('a disabled principal never holds a capability, even a listed one', () => {
    expect(hasCapability({ ...FAKE_PRINCIPAL_ADMIN, disabled: true }, 'sync.run')).toBe(false);
  });
});

describe('notFoundOrForbidden', () => {
  it('404 when the resource is outside scope, even if the capability is held', () => {
    const res = notFoundOrForbidden(FAKE_PRINCIPAL_ADMIN, 'template.manage', false, { type: 'org_unit', id: 'u1' });
    expect(res?.status).toBe(404);
    expect(mockDenied).toHaveBeenCalledWith(expect.objectContaining({ reason: 'out_of_scope' }));
  });

  it('404 (not 403) for an out-of-scope resource when the capability is also missing, so existence is hidden', () => {
    expect(notFoundOrForbidden(makePrincipal(), 'template.manage', false)?.status).toBe(404);
  });

  it('403 when in scope but the capability is missing', () => {
    expect(notFoundOrForbidden(makePrincipal(), 'template.manage', true)?.status).toBe(403);
  });

  it('null when in scope and the capability is held', () => {
    expect(notFoundOrForbidden(FAKE_PRINCIPAL_ADMIN, 'template.manage', true)).toBeNull();
  });
});

describe('getPrincipalForServerComponent', () => {
  it('null when unauthenticated', async () => {
    mockGetSession.mockResolvedValue(null as never);
    expect(await getPrincipalForServerComponent()).toBeNull();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('resolves the principal for the session user', async () => {
    expect(await getPrincipalForServerComponent()).toBe(FAKE_PRINCIPAL_ADMIN);
    expect(mockResolve).toHaveBeenCalledWith('user-123');
  });
});

describe('loginRefusal', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('refuses a disabled principal regardless of the flag', () => {
    expect(loginRefusal(makePrincipal({ disabled: true, roles: [] }))).toBe('disabled');
  });

  it('refuses a role-less principal only when REQUIRE_ROLE_TO_LOGIN=true', () => {
    const p = makePrincipal({ roles: [], capabilities: [] });
    expect(loginRefusal(p)).toBeNull();
    vi.stubEnv('REQUIRE_ROLE_TO_LOGIN', 'true');
    expect(loginRefusal(p)).toBe('no_role');
    expect(loginRefusal(makePrincipal({ roles: ['tt-bruger'] }))).toBeNull();
  });
});

describe('route handler type', () => {
  it('requires the Next route context (next build rejects an optional one)', () => {
    const handler = withAuthz('t', null, ok);
    // Type-level only (tsc checks it); never invoked.
    // @ts-expect-error the 2nd argument must be mandatory in the exported type
    const withoutContext = () => handler(req());
    expect(typeof withoutContext).toBe('function');
  });
});

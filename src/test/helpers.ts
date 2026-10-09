import { NextRequest } from 'next/server';
import { CAPABILITIES, type Principal } from '@/lib/authz/types';

export const FAKE_SESSION = { user: { id: 'user-123' } } as const;

export function makeJsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

/** A plain bruger (the implicit baseline). Override only what a test cares about. */
export function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: FAKE_SESSION.user.id,
    directoryUserUuid: null,
    roles: ['bruger'],
    capabilities: ['template.use'],
    scopes: {},
    disabled: false,
    source: 'baseline',
    ...overrides,
  };
}

/** Global administrator: every capability, global scope on the scoped ones. */
export const FAKE_PRINCIPAL_ADMIN: Principal = makePrincipal({
  userId: 'admin-123',
  directoryUserUuid: 'dddd0000-0000-4000-8000-000000000001',
  roles: ['bruger', 'admin'],
  capabilities: [...CAPABILITIES],
  scopes: {
    'template.manage': { global: true, roots: [] },
    'audit.read': { global: true, roots: [] },
    'directory.read': { global: true, roots: [] },
  },
  source: 'local',
});

/** The 2nd argument Next 15 passes to a route without dynamic segments. */
export const NO_PARAMS = { params: Promise.resolve({}) };

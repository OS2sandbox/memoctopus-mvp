// Shared fixtures for the admin component tests (not a test file itself).
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ToastProvider } from '@/components/ui/toast';
import type { MeResponse } from '@/lib/authz/me';

export const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

export const ADMIN_ME: MeResponse = {
  user: { id: 'admin-1', name: 'Anne Admin', email: 'anne@example.dk' },
  roles: ['tt-bruger', 'tt-administrator'],
  capabilities: ['template.use', 'template.manage', 'audit.read', 'audit.export', 'directory.read', 'access.manage', 'sync.run'],
  scopes: {
    'template.manage': { global: true, roots: [] },
    'audit.read': { global: true, roots: [] },
    'directory.read': { global: true, roots: [] },
  },
  source: 'local',
  readOnly: false,
};

export const ROLLEKATALOG_ME: MeResponse = { ...ADMIN_ME, source: 'rollekatalog', readOnly: true };

/** A skabelonansvarlig: may read the directory (scoped) but not manage access. */
export const READER_ME: MeResponse = {
  ...ADMIN_ME,
  user: { id: 'sk-1', name: 'Sven Skabelon', email: 'sven@example.dk' },
  roles: ['tt-bruger', 'tt-skabelonansvarlig'],
  capabilities: ['template.use', 'template.manage', 'directory.read'],
  scopes: {
    'template.manage': { global: false, roots: [] },
    'directory.read': { global: false, roots: [] },
  },
};

type Handler = (url: string, init?: RequestInit) => Promise<Response>;

/** Routes fetch by "METHOD /path" (query string ignored when the exact key is missing). */
export function installFetch(routes: Record<string, Handler | (() => Promise<Response>)>) {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const handler = routes[`${method} ${url}`] ?? routes[`${method} ${url.split('?')[0]}`];
    if (!handler) return json({ error: 'unrouted ' + method + ' ' + url }, 404);
    return handler(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

export const calls = (mock: ReturnType<typeof vi.fn>, method: string, prefix: string) =>
  mock.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && String(url).startsWith(prefix));

export const renderWithToasts = (ui: ReactElement) => render(<ToastProvider>{ui}</ToastProvider>);

export const NO_USERS = { users: [] };

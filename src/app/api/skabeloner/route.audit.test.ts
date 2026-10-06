// Runs the REAL recordServerEvent against a failing database: a broken audit
// write must never turn a successful template change into an error response.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The access gate (requireAppAccess) resolves the live principal; a plain
// tt-bruger unless a test says otherwise.
vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));

const h = vi.hoisted(() => ({ poolQuery: vi.fn() }));

vi.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
  return { db: { select: () => chain }, pool: { query: h.poolQuery, connect: vi.fn() } };
});
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/skabeloner/server', () => ({
  createSkabelon: vi.fn(),
  deleteSkabelon: vi.fn(),
}));

import { POST } from './route';
import { DELETE } from './[id]/route';
import { auth } from '@/lib/auth';
import { createSkabelon, deleteSkabelon } from '@/lib/skabeloner/server';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const SK_ID = '11111111-2222-4333-8444-555555555555';
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(auth.api.getSession).mockResolvedValue(FAKE_SESSION as never);
  h.poolQuery.mockReset();
  h.poolQuery.mockRejectedValue(Object.assign(new Error('connection to Hr. Jensen failed'), { code: '08006' }));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('template routes with a failing audit store', () => {
  it('POST still returns 201 and the warning carries no content', async () => {
    vi.mocked(createSkabelon).mockResolvedValue({ id: SK_ID, name: 'Fortrolig', prompt: '' } as never);
    const res = await POST(makeJsonReq('http://localhost/api/skabeloner', 'POST', { name: 'Fortrolig' }));
    expect(res.status).toBe(201);
    expect(h.poolQuery).toHaveBeenCalled();
    const logged = warn.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(logged).toContain('template.create');
    expect(logged).not.toMatch(/Jensen|Fortrolig/);
  });

  it('DELETE still returns ok', async () => {
    vi.mocked(deleteSkabelon).mockResolvedValue(true);
    const res = await DELETE(makeJsonReq(`http://localhost/api/skabeloner/${SK_ID}`, 'DELETE'), {
      params: Promise.resolve({ id: SK_ID }),
    });
    expect(res.status).toBe(200);
    expect(h.poolQuery).toHaveBeenCalled();
  });
});

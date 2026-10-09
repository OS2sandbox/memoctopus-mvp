// A claims-login user must see the shared prompts of THEIR roles in the picker's
// "Centrale skabeloner" group without configuring anything. This runs the REAL resolver
// (only the database is a fake) through GET /api/skabeloner, so the wiring is proven:
// the user id, the claims freshness of the mode and the role/group branch in the statement.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/skabeloner/server', () => ({ listSkabeloner: vi.fn(async () => []), createSkabelon: vi.fn() }));

const dbQuery = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ db: {}, pool: { query: dbQuery } }));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const ROW = {
  id: '99999999-2222-4333-8444-555555555555',
  name: 'Sagsbehandlerreferat',
  description: 'Til sagsbehandlere',
  include_deltagere: true,
  include_beslutningspunkter: true,
  include_dagsorden: false,
  include_dato: false,
  allow_user_instruction: false,
  allow_toggle_overrides: false,
  current_version: 4,
  prompt: 'HEMMELIG PROMPT SOM ALDRIG MÅ UD',
};

beforeEach(() => {
  vi.mocked(auth.api.getSession).mockResolvedValue(FAKE_SESSION as never);
  dbQuery.mockReset().mockResolvedValue({ rows: [ROW] });
  vi.stubEnv('ACCESS_SOURCE', 'claims');
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/skabeloner for a claims-login user', () => {
  it('lists the role-targeted shared prompt for the signed-in user, without its prompt text', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.centralSkabeloner).toEqual([
      expect.objectContaining({ id: ROW.id, source: 'central', name: 'Sagsbehandlerreferat', locked: true, version: 4 }),
    ]);
    expect(JSON.stringify(body)).not.toContain('HEMMELIG');
    expect(body.centralSkabeloner[0]).not.toHaveProperty('prompt');

    const [sql, params] = dbQuery.mock.calls[0];
    expect(params[0]).toBe(FAKE_SESSION.user.id);
    // ROLE_CLAIMS_MAX_SECONDS (default 8 h) is what makes the role/group branch count.
    expect(params[2]).toBe(28800);
    expect(sql).toContain('central_template_principal_targets');
    expect(sql).toContain('user_external_roles');
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it('outside claims mode the role/group branch is switched off (null freshness)', async () => {
    vi.stubEnv('ACCESS_SOURCE', 'rollekatalog');
    await GET();
    expect(dbQuery.mock.calls[0][1][2]).toBeNull();
  });

  it('a user who holds none of the roles gets an empty central list, and the personal ones are unaffected', async () => {
    dbQuery.mockResolvedValue({ rows: [] });
    const body = await (await GET()).json();
    expect(body).toEqual({ skabeloner: [], centralSkabeloner: [] });
  });

  it('a failing central lookup still returns the personal list', async () => {
    dbQuery.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).centralSkabeloner).toEqual([]);
  });
});

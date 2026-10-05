// The mock must behave like the verified Rollekatalog, otherwise every test built
// on it proves nothing. These tests pin the behaviours the app depends on.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MOCK_ORG_KEY, MOCK_READ_KEY, startMockRollekatalog, type MockRollekatalog } from './mock-server';

let mock: MockRollekatalog;
beforeAll(async () => {
  mock = await startMockRollekatalog();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.resetData();
  mock.setFaults([]);
  mock.clearRequests();
});

const get = (path: string, key?: string, headers: Record<string, string> = {}) =>
  fetch(`${mock.url}${path}`, { headers: { ...(key ? { ApiKey: key } : {}), ...headers } });

describe('auth', () => {
  it('401 without ApiKey, even with an Authorization header', async () => {
    expect((await get('/api/v2/constraint')).status).toBe(401);
    expect((await get('/api/v2/constraint', undefined, { Authorization: `Bearer ${MOCK_READ_KEY}` })).status).toBe(401);
    expect(mock.requests.map((r) => r.keyRole)).toEqual(['none', 'none']);
  });
  it('401 for an unknown key', async () => {
    expect((await get('/api/v2/constraint', 'nope')).status).toBe(401);
    expect(mock.requests[0].keyRole).toBe('unknown');
  });
  it('READ key: ok on read endpoints, 403 on organisation and manager', async () => {
    expect((await get('/api/v2/constraint', MOCK_READ_KEY)).status).toBe(200);
    expect((await get('/api/read/itsystem/roleAssignmentsWithContraints/os2taletiltekst', MOCK_READ_KEY)).status).toBe(200);
    expect((await get('/api/user/anne.p/rolesAsList?system=os2taletiltekst', MOCK_READ_KEY)).status).toBe(200);
    expect((await get('/api/organisation/v3', MOCK_READ_KEY)).status).toBe(403);
    expect((await get('/api/v2/manager', MOCK_READ_KEY)).status).toBe(403);
  });
  it('ORG key: ok on organisation and manager, 403 on the read endpoints', async () => {
    expect((await get('/api/organisation/v3', MOCK_ORG_KEY)).status).toBe(200);
    expect((await get('/api/v2/manager', MOCK_ORG_KEY)).status).toBe(200);
    expect((await get('/api/v2/constraint', MOCK_ORG_KEY)).status).toBe(403);
    expect((await get('/api/read/itsystem/roleAssignmentsWithContraints/os2taletiltekst', MOCK_ORG_KEY)).status).toBe(403);
    expect((await get('/api/user/anne.p/rolesAsList?system=os2taletiltekst', MOCK_ORG_KEY)).status).toBe(403);
  });
  it('only GET is served and unknown paths are 404', async () => {
    expect((await fetch(`${mock.url}/api/v2/constraint`, { method: 'POST', headers: { ApiKey: MOCK_READ_KEY } })).status).toBe(405);
    expect((await get('/api/v2/itsystem', MOCK_READ_KEY)).status).toBe(404);
  });
  it('never records the key itself', async () => {
    await get('/api/v2/constraint', MOCK_READ_KEY);
    expect(JSON.stringify(mock.requests)).not.toContain(MOCK_READ_KEY);
  });
});

describe('organisation v3', () => {
  it('returns only users with a position, and still carries cpr and nemloginUuid', async () => {
    mock.setData({
      users: [
        ...(await (await get('/api/organisation/v3', MOCK_ORG_KEY)).json()).users,
        { uuid: '7e5e0000-0000-4000-8000-0000000000aa', extUuid: null, userId: 'no.pos', name: 'No Position', email: null, disabled: false, positions: [] },
      ],
    });
    const body = await (await get('/api/organisation/v3', MOCK_ORG_KEY)).json();
    expect(body.users.some((u: { userId: string }) => u.userId === 'no.pos')).toBe(false);
    expect(body.users.length).toBe(9);
    expect(body.users[0]).toHaveProperty('cpr', '0000000000');
    expect(body.users[0]).toHaveProperty('nemloginUuid');
    expect(body.users[0]).toHaveProperty('phone');
  });
});

describe('rolesAsList', () => {
  it('404 with an EMPTY body for an unknown user, unknown system, unknown domain', async () => {
    for (const p of [
      '/api/user/nobody/rolesAsList?system=os2taletiltekst',
      '/api/user/anne.p/rolesAsList?system=other',
      '/api/user/anne.p/rolesAsList?system=os2taletiltekst&domain=Nope',
    ]) {
      const res = await get(p, MOCK_READ_KEY);
      expect(res.status, p).toBe(404);
      expect(await res.text(), p).toBe('');
    }
  });
  it('400 when the required system parameter is missing', async () => {
    expect((await get('/api/user/anne.p/rolesAsList', MOCK_READ_KEY)).status).toBe(400);
  });
  it('finds a user by extUuid as well', async () => {
    const res = await get('/api/user/9d3c0000-0000-4000-8000-000000000003/rolesAsList?system=os2taletiltekst', MOCK_READ_KEY);
    expect(res.status).toBe(200);
  });
  it('a disabled user is 200 with disabled:true and roles NOT blanked', async () => {
    const body = await (await get('/api/user/sofie.s/rolesAsList?system=os2taletiltekst', MOCK_READ_KEY)).json();
    expect(body.disabled).toBe(true);
    expect(body.systemRoles).toEqual(['tt-bruger']);
  });
  it('supports per-user overrides, null = 404', async () => {
    mock.setData({ rolesAsList: { 'anne.p': null, 'lars.f': { systemRoles: [], disabled: false } } });
    expect((await get('/api/user/anne.p/rolesAsList?system=os2taletiltekst', MOCK_READ_KEY)).status).toBe(404);
    expect(await (await get('/api/user/lars.f/rolesAsList?system=os2taletiltekst', MOCK_READ_KEY)).json()).toEqual({ systemRoles: [], disabled: false });
  });
});

describe('roleAssignmentsWithContraints', () => {
  it('unknown system is 404 with body []', async () => {
    const res = await get('/api/read/itsystem/roleAssignmentsWithContraints/other', MOCK_READ_KEY);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual([]);
  });
  it('serves the fixture, including the user absent from organisation v3', async () => {
    const body = await (await get('/api/read/itsystem/roleAssignmentsWithContraints/os2taletiltekst', MOCK_READ_KEY)).json();
    expect(body.map((u: { userId: string }) => u.userId)).toContain('ghost.u');
  });
});

describe('test controls', () => {
  it('setData changes what is served and resetData restores the fixtures', async () => {
    mock.setData({ constraints: [] });
    expect(await (await get('/api/v2/constraint', MOCK_READ_KEY)).json()).toEqual([]);
    mock.resetData();
    expect((await (await get('/api/v2/constraint', MOCK_READ_KEY)).json()).length).toBe(3);
  });
  it('faults apply `times` times, after the auth checks', async () => {
    mock.setFaults([{ match: '/api/v2/constraint', status: 500, times: 1 }]);
    expect((await get('/api/v2/constraint', 'nope')).status).toBe(401);
    expect((await get('/api/v2/constraint', MOCK_READ_KEY)).status).toBe(500);
    expect((await get('/api/v2/constraint', MOCK_READ_KEY)).status).toBe(200);
  });
  it('records method, path, query, key role and status in order', async () => {
    await get('/api/user/anne.p/rolesAsList?system=os2taletiltekst', MOCK_READ_KEY);
    await get('/api/organisation/v3', MOCK_READ_KEY);
    expect(mock.requests).toEqual([
      { method: 'GET', path: '/api/user/anne.p/rolesAsList', query: 'system=os2taletiltekst', keyRole: 'read', status: 200 },
      { method: 'GET', path: '/api/organisation/v3', query: '', keyRole: 'read', status: 403 },
    ]);
  });
});

describe('registration endpoints (ITSYSTEM key)', () => {
  const call = (method: string, path: string, key: string, body?: unknown) =>
    fetch(`${mock.url}${path}`, {
      method,
      headers: { ApiKey: key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  it('creates and lists an it-system and its roles', async () => {
    const created = await call('POST', '/api/v2/itsystem', mock.itSystemKey, { name: 'X', identifier: 'x', systemtype: 'SAML' });
    expect(created.status).toBe(200);
    const sys = (await created.json()) as { id: number };
    expect(((await (await call('GET', '/api/v2/itsystem', mock.itSystemKey)).json()) as unknown[]).length).toBe(1);
    const role = await call('POST', `/api/v2/itsystem/${sys.id}/systemroles`, mock.itSystemKey, { name: 'R', identifier: 'r' });
    expect(role.status).toBe(201);
    expect(((await (await call('GET', `/api/v2/itsystem/${sys.id}/systemroles`, mock.itSystemKey)).json()) as unknown[]).length).toBe(1);
    expect((await call('GET', '/api/v2/itsystem/999/systemroles', mock.itSystemKey)).status).toBe(404);
  });

  it('rejects an unknown systemtype, a nameless role and an unknown constraint id', async () => {
    expect((await call('POST', '/api/v2/itsystem', mock.itSystemKey, { name: 'X', identifier: 'x', systemtype: 'NOPE' })).status).toBe(400);
    const sys = (await (await call('POST', '/api/v2/itsystem', mock.itSystemKey, { name: 'X', identifier: 'x', systemtype: 'SAML' })).json()) as { id: number };
    expect((await call('POST', `/api/v2/itsystem/${sys.id}/systemroles`, mock.itSystemKey, { identifier: 'r' })).status).toBe(400);
    expect(
      (await call('POST', `/api/v2/itsystem/${sys.id}/systemroles`, mock.itSystemKey, { name: 'R', identifier: 'r', supportedConstraintTypes: [{ constraintType: { id: 999 } }] })).status,
    ).toBe(400);
  });

  it('keeps the read-only keys out: POST stays 405 and GET stays 404 for READ/ORG', async () => {
    expect((await call('POST', '/api/v2/itsystem', MOCK_READ_KEY, { systemtype: 'SAML' })).status).toBe(405);
    expect((await call('GET', '/api/v2/itsystem', MOCK_ORG_KEY)).status).toBe(404);
  });

  it('the ITSYSTEM key reads constraints but is refused on organisation endpoints', async () => {
    expect((await call('GET', '/api/v2/constraint', mock.itSystemKey)).status).toBe(200);
    expect((await call('GET', '/api/organisation/v3', mock.itSystemKey)).status).toBe(403);
  });
});

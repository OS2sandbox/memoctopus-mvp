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
  const RA = '/api/read/itsystem/roleAssignmentsWithContraints/os2taletiltekst';
  it('401 without ApiKey, even with an Authorization header', async () => {
    expect((await get(RA)).status).toBe(401);
    expect((await get(RA, undefined, { Authorization: `Bearer ${MOCK_READ_KEY}` })).status).toBe(401);
    expect(mock.requests.map((r) => r.keyRole)).toEqual(['none', 'none']);
  });
  it('401 for an unknown key', async () => {
    expect((await get(RA, 'nope')).status).toBe(401);
    expect(mock.requests[0].keyRole).toBe('unknown');
  });
  it('READ key: ok on read endpoints, 403 on organisation', async () => {
    expect((await get(RA, MOCK_READ_KEY)).status).toBe(200);
    expect((await get('/api/organisation/v3', MOCK_READ_KEY)).status).toBe(403);
  });
  it('ORG key: ok on organisation, 403 on the read endpoints', async () => {
    expect((await get('/api/organisation/v3', MOCK_ORG_KEY)).status).toBe(200);
    expect((await get(RA, MOCK_ORG_KEY)).status).toBe(403);
  });
  it('only GET is served and unknown paths are 404', async () => {
    expect((await fetch(`${mock.url}${RA}`, { method: 'POST', headers: { ApiKey: MOCK_READ_KEY } })).status).toBe(405);
    expect((await get('/api/v2/manager', MOCK_ORG_KEY)).status).toBe(404);
    expect((await get('/api/v2/constraint', MOCK_READ_KEY)).status).toBe(404);
  });
  it('never records the key itself', async () => {
    await get(RA, MOCK_READ_KEY);
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

describe('roleAssignmentsWithContraints', () => {
  it('unknown system is 404 with body []', async () => {
    const res = await get('/api/read/itsystem/roleAssignmentsWithContraints/other', MOCK_READ_KEY);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual([]);
  });
  it('an unknown domain is 404', async () => {
    expect((await get('/api/read/itsystem/roleAssignmentsWithContraints/os2taletiltekst?domain=Nope', MOCK_READ_KEY)).status).toBe(404);
  });
  it('serves the fixture, including the user absent from organisation v3', async () => {
    const body = await (await get('/api/read/itsystem/roleAssignmentsWithContraints/os2taletiltekst', MOCK_READ_KEY)).json();
    expect(body.map((u: { userId: string }) => u.userId)).toContain('ghost.u');
  });
});

describe('test controls', () => {
  const RA = '/api/read/itsystem/roleAssignmentsWithContraints/os2taletiltekst';
  it('setData changes what is served and resetData restores the fixtures', async () => {
    mock.setData({ roleAssignments: [] });
    expect(await (await get(RA, MOCK_READ_KEY)).json()).toEqual([]);
    mock.resetData();
    expect((await (await get(RA, MOCK_READ_KEY)).json()).length).toBeGreaterThan(0);
  });
  it('faults apply `times` times, after the auth checks', async () => {
    mock.setFaults([{ match: '/api/read/', status: 500, times: 1 }]);
    expect((await get(RA, 'nope')).status).toBe(401);
    expect((await get(RA, MOCK_READ_KEY)).status).toBe(500);
    expect((await get(RA, MOCK_READ_KEY)).status).toBe(200);
  });
  it('records method, path, query, key role and status in order', async () => {
    await get(`${RA}?domain=Administrativt`, MOCK_READ_KEY);
    await get('/api/organisation/v3', MOCK_READ_KEY);
    expect(mock.requests).toEqual([
      { method: 'GET', path: RA, query: 'domain=Administrativt', keyRole: 'read', status: 200 },
      { method: 'GET', path: '/api/organisation/v3', query: '', keyRole: 'read', status: 403 },
    ]);
  });
});

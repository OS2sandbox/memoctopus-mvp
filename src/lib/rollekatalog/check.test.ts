import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRollekatalogCheck, type CheckOptions } from './check';
import { fixtureData, startMockRollekatalog, type MockRollekatalog } from './mock-server';

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
afterEach(() => vi.unstubAllEnvs());

const opts = (extra: CheckOptions = {}): CheckOptions => ({
  baseUrl: mock.url,
  readKey: mock.readKey,
  orgKey: mock.orgKey,
  sleep: async () => {},
  ...extra,
});

const knownUserId = () => (fixtureData().roleAssignments as Array<{ userId?: string }>).find((a) => a.userId)!.userId!;
const byName = (r: Awaited<ReturnType<typeof runRollekatalogCheck>>, name: string) =>
  r.endpoints.find((e) => e.endpoint === name)!;

describe('runRollekatalogCheck against the mock', () => {
  it('reports every endpoint ok with counts and status 200', async () => {
    const report = await runRollekatalogCheck(opts({ rolesAsListUserId: knownUserId() }));
    expect(report.endpoints.map((e) => e.endpoint)).toEqual([
      'organisation',
      'managers',
      'roleAssignments',
      'constraints',
      'rolesAsList',
    ]);
    for (const e of report.endpoints) {
      expect(e).toMatchObject({ ok: true, httpStatusCode: 200, schemaValid: true });
      expect(e.errorCode).toBeUndefined();
    }
    expect(byName(report, 'organisation').counts).toEqual({ usersSeen: 9, orgUnitsSeen: 5 });
    expect(byName(report, 'roleAssignments').counts?.ourRolesSeen).toBeGreaterThan(0);
    expect(byName(report, 'roleAssignments').counts?.assignmentsSeen).toBeGreaterThanOrEqual(
      byName(report, 'roleAssignments').counts!.ourRolesSeen,
    );
    expect(byName(report, 'constraints').counts?.orgUnitConstraintTypesSeen).toBeGreaterThan(0);
    expect(byName(report, 'rolesAsList').counts?.ourRolesSeen).toBeGreaterThan(0);
  });

  it('calls each endpoint exactly once, with the right key kind', async () => {
    await runRollekatalogCheck(opts({ rolesAsListUserId: knownUserId() }));
    expect(mock.requests.map((r) => [r.path.replace(/\/api\/user\/[^/]+/, '/api/user/:id'), r.keyRole])).toEqual([
      ['/api/organisation/v3', 'org'],
      ['/api/v2/manager', 'org'],
      ['/api/read/itsystem/roleAssignmentsWithContraints/os2taletiltekst', 'read'],
      ['/api/v2/constraint', 'read'],
      ['/api/user/:id/rolesAsList', 'read'],
    ]);
  });

  it('does not retry a failing endpoint (one call per endpoint)', async () => {
    mock.setFaults([{ match: '/api/v2/manager', status: 503 }]);
    const report = await runRollekatalogCheck(opts());
    expect(byName(report, 'managers')).toMatchObject({ ok: false, httpStatusCode: 503, errorCode: 'server_error', schemaValid: false });
    expect(mock.requests.filter((r) => r.path === '/api/v2/manager')).toHaveLength(1);
  });

  it('skips rolesAsList without a user id and does not call it', async () => {
    const report = await runRollekatalogCheck(opts());
    expect(byName(report, 'rolesAsList')).toEqual({
      endpoint: 'rolesAsList',
      ok: false,
      httpStatusCode: null,
      schemaValid: false,
      skipped: true,
    });
    expect(mock.requests.some((r) => r.path.includes('rolesAsList'))).toBe(false);
  });

  it('reports a wrong key per endpoint as forbidden (ORG key refused on read endpoints)', async () => {
    const report = await runRollekatalogCheck(opts({ readKey: mock.orgKey, rolesAsListUserId: knownUserId() }));
    expect(byName(report, 'organisation').ok).toBe(true);
    expect(byName(report, 'roleAssignments')).toMatchObject({ ok: false, httpStatusCode: 403, errorCode: 'forbidden' });
    expect(byName(report, 'constraints')).toMatchObject({ ok: false, errorCode: 'forbidden' });
  });

  it('reports 401 for an unknown key', async () => {
    const report = await runRollekatalogCheck(opts({ orgKey: 'wrong-key' }));
    expect(byName(report, 'organisation')).toMatchObject({ ok: false, httpStatusCode: 401, errorCode: 'unauthorized' });
  });

  it('reports 404 for an unknown rolesAsList user', async () => {
    const report = await runRollekatalogCheck(opts({ rolesAsListUserId: 'nobody-here' }));
    expect(byName(report, 'rolesAsList')).toMatchObject({ ok: false, httpStatusCode: 404, errorCode: 'not_found' });
  });

  it('schemaValid is false (status kept) when a 200 body does not match the schema', async () => {
    mock.setData({ constraints: [{ nope: 1 }] });
    const report = await runRollekatalogCheck(opts());
    expect(byName(report, 'constraints')).toMatchObject({
      ok: false,
      httpStatusCode: 200,
      schemaValid: false,
      errorCode: 'invalid_response',
    });
  });

  it('maps a timeout to the short code with no status', async () => {
    mock.setFaults([{ match: '/api/v2/constraint', delayMs: 300 }]);
    const report = await runRollekatalogCheck(opts({ timeoutMs: 50 }));
    expect(byName(report, 'constraints')).toMatchObject({ ok: false, httpStatusCode: null, errorCode: 'timeout' });
  });

  it('too_large from an oversize body', async () => {
    mock.setFaults([{ match: '/api/v2/constraint', oversize: { bytes: 5000, chunked: true } }]);
    const report = await runRollekatalogCheck(opts({ maxBytes: 1000 }));
    expect(byName(report, 'constraints')).toMatchObject({ ok: false, errorCode: 'too_large' });
  });
});

describe('configuration', () => {
  it('reports not_configured without URL and keys, with every endpoint failing by code only', async () => {
    vi.stubEnv('ROLLEKATALOG_URL', '');
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', '');
    vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', '');
    const report = await runRollekatalogCheck({ rolesAsListUserId: 'x' });
    expect(report.configured).toBe(false);
    expect(report.configIssue).toBe('not_configured');
    for (const e of report.endpoints) expect(e).toMatchObject({ ok: false, errorCode: 'not_configured', httpStatusCode: null });
  });

  it('reports insecure_url for an http URL to a remote host', async () => {
    vi.stubEnv('ROLLEKATALOG_URL', 'http://rollekatalog.example.dk');
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', 'k1');
    vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', 'k2');
    const fetchSpy = vi.fn();
    const report = await runRollekatalogCheck({ fetch: fetchSpy as never });
    expect(report.configIssue).toBe('insecure_url');
    expect(report.endpoints[0]).toMatchObject({ errorCode: 'insecure_url' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is configured when URL and both keys come from the environment', async () => {
    vi.stubEnv('ROLLEKATALOG_URL', mock.url);
    vi.stubEnv('ROLLEKATALOG_READ_API_KEY', mock.readKey);
    vi.stubEnv('ROLLEKATALOG_ORG_API_KEY', mock.orgKey);
    const report = await runRollekatalogCheck();
    expect(report.configured).toBe(true);
    expect(report.configIssue).toBeNull();
    expect(byName(report, 'organisation').ok).toBe(true);
  });
});

describe('privacy: nothing from the response and no secret is ever reported', () => {
  it('flags that cpr/nemlogin fields are present in the organisation response but never echoes them', async () => {
    const raw = fixtureData();
    const cprs = raw.users.flatMap((u) => [String(u.cpr ?? ''), String(u.nemloginUuid ?? '')]).filter(Boolean);
    expect(cprs.length).toBeGreaterThan(0);

    const report = await runRollekatalogCheck(opts({ rolesAsListUserId: knownUserId() }));
    expect(byName(report, 'organisation').cprFieldPresentInResponse).toBe(true);
    // The other fixtures carry no such key.
    expect(byName(report, 'constraints').cprFieldPresentInResponse).toBe(false);

    const serialised = JSON.stringify(report);
    for (const secret of cprs) expect(serialised).not.toContain(secret);
    for (const u of raw.users) {
      expect(serialised).not.toContain(u.name);
      expect(serialised).not.toContain(String(u.email));
      expect(serialised).not.toContain(u.userId);
    }
    expect(serialised).not.toContain(mock.readKey);
    expect(serialised).not.toContain(mock.orgKey);
    expect(serialised).not.toContain(mock.url);
    // The only key naming cpr is the boolean flag; no nemlogin key, no value-bearing field.
    expect(serialised).not.toMatch(/nemlogin/i);
  });

  it('reports cprFieldPresentInResponse=false when Rollekatalog sends none', async () => {
    mock.setData({ users: fixtureData().users.map(({ cpr: _c, nemloginUuid: _n, ...rest }) => rest as never) });
    const report = await runRollekatalogCheck(opts());
    expect(byName(report, 'organisation').cprFieldPresentInResponse).toBe(false);
  });

  it('detects a nested sensitive key (any depth, any case)', async () => {
    mock.setData({ constraints: [{ id: 1, entityId: 'x', name: 'n', deep: { list: [{ CprNummer: '0101011234' }] } }] });
    const report = await runRollekatalogCheck(opts());
    const c = byName(report, 'constraints');
    expect(c.cprFieldPresentInResponse).toBe(true);
    expect(JSON.stringify(c)).not.toContain('0101011234');
  });

  it('error reports contain only whitelisted keys', async () => {
    mock.setFaults([{ match: '/api/organisation/v3', status: 500 }]);
    const report = await runRollekatalogCheck(opts({ orgKey: 'super-secret-org-key' }));
    const org = byName(report, 'organisation');
    expect(Object.keys(org).sort()).toEqual(['endpoint', 'errorCode', 'httpStatusCode', 'ok', 'schemaValid']);
    expect(JSON.stringify(report)).not.toContain('super-secret-org-key');
  });
});

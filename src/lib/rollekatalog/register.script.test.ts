// Runs scripts/rollekatalog-register.mjs as a child process against the in-process mock.
// (execFile, not spawnSync: the mock lives in this process and needs a free event loop.)
import { execFile } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_KEYS } from '@/lib/authz/types';
import { MOCK_ITSYSTEM_KEY, startMockRollekatalog, type MockRollekatalog } from './mock-server';

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'rollekatalog-register.mjs');
const ORG_UNIT_CONSTRAINT = 'http://digital-identity.dk/constraints/orgunit/1';

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(args: string[], env: Record<string, string>): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv, timeout: 20000 },
      (err: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

let mock: MockRollekatalog;
const env = (extra: Record<string, string> = {}) => ({
  ROLLEKATALOG_URL: mock.url,
  ROLLEKATALOG_ITSYSTEM_API_KEY: mock.itSystemKey,
  ...extra,
});
const writes = () => mock.requests.filter((r) => r.method !== 'GET');

function expectNoKeyLeak(r: Result, ...keys: string[]) {
  for (const k of [mock.itSystemKey, mock.readKey, mock.orgKey, ...keys]) {
    expect(r.stdout).not.toContain(k);
    expect(r.stderr).not.toContain(k);
  }
}

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

describe('rollekatalog-register.mjs', () => {
  it('dry-run is the default: prints a plan and writes nothing', async () => {
    const r = await runScript([], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('dry-run');
    expect(r.stdout).toContain('ville oprette');
    for (const k of ROLE_KEYS) expect(r.stdout).toContain(k);
    expect(r.stdout).toContain('--apply');
    expect(writes()).toEqual([]);
    expect(mock.registry.itSystems).toEqual([]);
    expectNoKeyLeak(r);
  });

  it('--apply creates the IT system and all four roles with the right shapes', async () => {
    const r = await runScript(['--apply'], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('oprettet=5');

    expect(mock.registry.itSystems).toHaveLength(1);
    const sys = mock.registry.itSystems[0];
    expect(sys).toMatchObject({ identifier: 'os2taletiltekst', systemtype: 'SAML', canEditThroughApi: false, apiManagedRoleAssignments: false });

    const roles = mock.registry.systemRoles[String(sys.id)] as unknown as Array<{
      identifier: string;
      weight: number;
      supportedConstraintTypes: Array<{ constraintType: { id: number; entityId: string }; mandatory: boolean }>;
    }>;
    expect(roles.map((x) => x.identifier)).toEqual([...ROLE_KEYS]);
    expect(new Set(roles.map((x) => x.weight))).toEqual(new Set([1]));
    const byId = Object.fromEntries(roles.map((x) => [x.identifier, x]));
    for (const id of ['tt-skabelonansvarlig', 'tt-logleser']) {
      expect(byId[id].supportedConstraintTypes).toHaveLength(1);
      expect(byId[id].supportedConstraintTypes[0].constraintType).toMatchObject({ id: 1, entityId: ORG_UNIT_CONSTRAINT });
    }
    expect(byId['tt-bruger'].supportedConstraintTypes).toEqual([]);
    expect(byId['tt-administrator'].supportedConstraintTypes).toEqual([]);
    // Only the ITSYSTEM key may be used, and only GET + POST.
    expect(new Set(mock.requests.map((x) => x.keyRole))).toEqual(new Set(['itsystem']));
    expect(new Set(mock.requests.map((x) => x.method))).toEqual(new Set(['GET', 'POST']));
    expectNoKeyLeak(r);
  });

  it('a second --apply is a no-op', async () => {
    await runScript(['--apply'], env());
    mock.clearRequests();
    const r = await runScript(['--apply'], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('oprettet=0, findes=5, afvigelser=0');
    expect(writes()).toEqual([]);
    expect(mock.registry.itSystems).toHaveLength(1);
    expect(Object.values(mock.registry.systemRoles).flat()).toHaveLength(4);
  });

  it('dry-run after apply reports everything as existing', async () => {
    await runScript(['--apply'], env());
    const r = await runScript([], env());
    expect(r.stdout).toContain('findes=5');
    expect(r.stdout).not.toContain('[ville oprette]');
  });

  it('reports drift without overwriting, and still creates what is missing', async () => {
    mock.setRegistry({
      itSystems: [{ id: 42, identifier: 'os2taletiltekst', name: 'Noget andet', systemtype: 'SAML', accesBlocked: true }],
      systemRoles: {
        '42': [
          { id: 100, identifier: 'tt-bruger', name: 'Almindelig bruger', description: 'Anden tekst', weight: 3, supportedConstraintTypes: [] },
          { id: 101, identifier: 'tt-logleser', name: 'Logleser', description: 'Kan læse revisionsloggen for sin enhed og dens underenheder.', weight: 1, supportedConstraintTypes: [] },
        ],
      },
      nextId: 200,
    });
    const before = JSON.stringify(mock.registry);
    const r = await runScript(['--apply'], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[afvigelse\] IT-system/);
    expect(r.stdout).toContain('Noget andet');
    expect(r.stdout).toContain('accesBlocked');
    expect(r.stdout).toMatch(/\[afvigelse\] tt-bruger/);
    expect(r.stdout).toContain('vægt: 3');
    expect(r.stdout).toMatch(/\[afvigelse\] tt-logleser/);
    expect(r.stdout).toContain('afgrænsninger');
    // Existing objects are untouched, the two missing roles were created.
    const roles = mock.registry.systemRoles['42'];
    expect(roles.map((x) => x.identifier)).toEqual(['tt-bruger', 'tt-logleser', 'tt-skabelonansvarlig', 'tt-administrator']);
    expect(roles[0]).toMatchObject({ name: 'Almindelig bruger', weight: 3 });
    expect(mock.registry.itSystems).toHaveLength(1);
    expect(mock.registry.itSystems[0].name).toBe('Noget andet');
    expect(JSON.stringify(mock.registry)).not.toBe(before);
    expect(r.stdout).toContain('oprettet=2, findes=0, afvigelser=3');
  });

  it('a wrong key gives a clean error without the key anywhere in the output', async () => {
    const secret = 'super-secret-wrong-key-123';
    const r = await runScript(['--apply'], env({ ROLLEKATALOG_ITSYSTEM_API_KEY: secret }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unauthorized');
    expect(r.stderr).toContain('401');
    expectNoKeyLeak(r, secret);
    expect(writes()).toEqual([]);
  });

  it('the READ key is not an ITSYSTEM key', async () => {
    const r = await runScript([], env({ ROLLEKATALOG_ITSYSTEM_API_KEY: mock.readKey }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not_found|forbidden/);
    expectNoKeyLeak(r);
  });

  it('refuses a non-https URL (insecure_url) before any request', async () => {
    const r = await runScript(['--apply'], env({ ROLLEKATALOG_URL: 'http://rollekatalog.example.dk' }));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('insecure_url');
    expectNoKeyLeak(r);
    expect(mock.requests).toEqual([]);
  });

  it('refuses a URL carrying credentials', async () => {
    const r = await runScript([], env({ ROLLEKATALOG_URL: 'https://user:pw@rollekatalog.example.dk' }));
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain('pw@');
  });

  it('usage errors exit 2: missing key, missing URL, unknown flag, bad identifier', async () => {
    expect((await runScript([], { ROLLEKATALOG_URL: mock.url })).code).toBe(2);
    expect((await runScript([], { ROLLEKATALOG_ITSYSTEM_API_KEY: MOCK_ITSYSTEM_KEY })).code).toBe(2);
    expect((await runScript(['--force'], env())).code).toBe(2);
    expect((await runScript([], env({ ROLLEKATALOG_ITSYSTEM_ID: 'has space' }))).code).toBe(2);
    expect(mock.requests).toEqual([]);
  });

  it('--help exits 0 without any request', async () => {
    const r = await runScript(['--help'], {});
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--apply');
  });

  it('uses ROLLEKATALOG_ITSYSTEM_ID for the identifier', async () => {
    const r = await runScript(['--apply'], env({ ROLLEKATALOG_ITSYSTEM_ID: 'min-test' }));
    expect(r.code).toBe(0);
    expect(mock.registry.itSystems[0].identifier).toBe('min-test');
  });

  it('fails (exit 1) when the org-unit constraint type does not exist, and creates nothing', async () => {
    mock.setData({ constraints: [] });
    const r = await runScript(['--apply'], env());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('constraint_type_missing');
    expect(writes()).toEqual([]);
  });

  it('fails (exit 1) when two IT systems share the identifier instead of guessing', async () => {
    mock.setRegistry({
      itSystems: [
        { id: 1, identifier: 'os2taletiltekst', name: 'A', systemtype: 'SAML' },
        { id: 2, identifier: 'os2taletiltekst', name: 'B', systemtype: 'SAML' },
      ],
    });
    const r = await runScript(['--apply'], env());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('ambiguous_itsystem');
    expect(writes()).toEqual([]);
  });

  it('maps a server error to a short code and stops', async () => {
    // Faults apply to the read endpoints of the mock, which the script also calls.
    mock.setFaults([{ match: '/api/v2/constraint', status: 503 }]);
    const r = await runScript(['--apply'], env());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('server_error');
    expectNoKeyLeak(r);
  });

  it('never prints other IT systems of the municipality', async () => {
    mock.setRegistry({
      itSystems: [{ id: 9, identifier: 'andet-system', name: 'Hemmeligt andet system', systemtype: 'SAML', email: 'ejer@example.dk' }],
      nextId: 10,
    });
    const r = await runScript(['--apply'], env());
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('Hemmeligt');
    expect(r.stdout + r.stderr).not.toContain('ejer@example.dk');
  });
});

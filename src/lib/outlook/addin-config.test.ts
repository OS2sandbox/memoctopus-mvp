import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// outlookAddinConfig() decides whether the add-in is on. When an operator sets
// OUTLOOK_ADDIN_ENABLED=true and it still stays off, the only symptom is a 404 on
// the manifest, so the reason has to be in the server log.

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const saved = { ...process.env };

/** A fresh module each time: the warning is logged once per process. */
async function load() {
  vi.resetModules();
  return (await import('@/lib/auth/providers')).outlookAddinConfig;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.OUTLOOK_ADDIN_ENABLED = 'true';
  process.env.TEAMS_GRAPH_ENABLED = 'true';
  process.env.MICROSOFT_CLIENT_ID = CLIENT;
  process.env.MICROSOFT_CLIENT_SECRET = 'secret';
  process.env.MICROSOFT_TENANT_ID = TENANT;
  delete process.env.MICROSOFT_ENABLED;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe('outlookAddinConfig', () => {
  it('is on, quietly, with a tenant id and a client id', async () => {
    const outlookAddinConfig = await load();
    expect(outlookAddinConfig()).toEqual({ clientId: CLIENT, tenantId: TENANT, token: 'api' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('signs the add-in in with its own app, quietly, when OUTLOOK_ADDIN_CLIENT_ID is set', async () => {
    process.env.OUTLOOK_ADDIN_CLIENT_ID = 'DBDBDBDB-5555-4444-A121-FB0D3041449E';
    const outlookAddinConfig = await load();
    expect(outlookAddinConfig()).toEqual({
      clientId: 'dbdbdbdb-5555-4444-a121-fb0d3041449e',
      tenantId: TENANT,
      token: 'id',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('says nothing while the add-in is not asked for', async () => {
    delete process.env.OUTLOOK_ADDIN_ENABLED;
    process.env.MICROSOFT_TENANT_ID = 'kommune.dk';
    const outlookAddinConfig = await load();
    expect(outlookAddinConfig()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  const rejected: [string, () => void, RegExp][] = [
    ['the tenant is a domain', () => { process.env.MICROSOFT_TENANT_ID = 'kommune.dk'; }, /MICROSOFT_TENANT_ID.*kommune\.dk/],
    ['the tenant is left at common', () => { delete process.env.MICROSOFT_TENANT_ID; }, /MICROSOFT_TENANT_ID.*common/],
    ['the client id is not a GUID', () => { process.env.MICROSOFT_CLIENT_ID = 'my-app'; }, /MICROSOFT_CLIENT_ID/],
    ['the Graph integration is off', () => { delete process.env.TEAMS_GRAPH_ENABLED; }, /TEAMS_GRAPH_ENABLED/],
    ['Microsoft sign-in is off', () => { process.env.MICROSOFT_ENABLED = 'false'; }, /Microsoft/],
    ['the add-in\'s own client id is not a GUID', () => { process.env.OUTLOOK_ADDIN_CLIENT_ID = 'addin-app'; }, /OUTLOOK_ADDIN_CLIENT_ID.*addin-app/],
  ];

  it.each(rejected)('logs why it stays off when %s, once', async (_name, configure, reason) => {
    configure();
    const outlookAddinConfig = await load();

    expect(outlookAddinConfig()).toBeNull();
    expect(outlookAddinConfig()).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toMatch(/OUTLOOK_ADDIN_ENABLED/);
    expect(message).toMatch(reason);
    expect(message).not.toContain('secret');
  });
});

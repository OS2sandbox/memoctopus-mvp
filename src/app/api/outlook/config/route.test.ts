import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));

import { GET } from './route';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const ADDIN_CLIENT = 'dbdbdbdb-5555-4444-a121-fb0d3041449e';
const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

function enable() {
  process.env.OUTLOOK_ADDIN_ENABLED = 'true';
  process.env.TEAMS_GRAPH_ENABLED = 'true';
  process.env.MICROSOFT_CLIENT_ID = CLIENT;
  process.env.MICROSOFT_CLIENT_SECRET = 'not-sent-anywhere';
  process.env.MICROSOFT_TENANT_ID = TENANT;
}

describe('GET /api/outlook/config', () => {
  it('says the add-in is off when the flag is not set', async () => {
    enable();
    delete process.env.OUTLOOK_ADDIN_ENABLED;
    expect(await (await GET()).json()).toEqual({ enabled: false });
  });

  it('hands out the client id, tenant and scope, and never the secret', async () => {
    enable();
    const res = await GET();
    const text = await res.clone().text();
    expect(await res.json()).toEqual({
      enabled: true,
      clientId: CLIENT,
      tenantId: TENANT,
      token: 'api',
      scopes: [`api://${CLIENT}/access_as_user`],
    });
    expect(text).not.toContain('not-sent-anywhere');
  });

  it('points the add-in at its own app, for an ID token, when OUTLOOK_ADDIN_CLIENT_ID is set', async () => {
    enable();
    process.env.OUTLOOK_ADDIN_CLIENT_ID = ` ${ADDIN_CLIENT.toUpperCase()} `;
    expect(await (await GET()).json()).toEqual({
      enabled: true,
      clientId: ADDIN_CLIENT,
      tenantId: TENANT,
      token: 'id',
      scopes: ['openid', 'profile'],
    });
  });

  it('stays on the dashboard app when OUTLOOK_ADDIN_CLIENT_ID is blank or the same app', async () => {
    for (const value of ['', CLIENT]) {
      enable();
      process.env.OUTLOOK_ADDIN_CLIENT_ID = value;
      expect(await (await GET()).json()).toMatchObject({ clientId: CLIENT, token: 'api' });
    }
  });

  it('switches the add-in off on a malformed OUTLOOK_ADDIN_CLIENT_ID', async () => {
    enable();
    process.env.OUTLOOK_ADDIN_CLIENT_ID = 'not-a-guid';
    expect(await (await GET()).json()).toEqual({ enabled: false });
  });
});

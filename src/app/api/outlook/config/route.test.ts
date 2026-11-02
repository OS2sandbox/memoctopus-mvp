import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));

import { GET } from './route';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '33333333-3333-3333-3333-333333333333';
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
  delete process.env.TEAMS_DELETE_RECORDING;
  delete process.env.TEAMS_ARTIFACT_MODE;
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
      scopes: [`api://${CLIENT}/access_as_user`],
      deletesRecording: true,
    });
    expect(text).not.toContain('not-sent-anywhere');
  });

  // The pane tells the user what happens to the recording, so it must not promise
  // a deletion this deployment does not do.
  it('says the recording is kept when TEAMS_DELETE_RECORDING=false', async () => {
    enable();
    process.env.TEAMS_DELETE_RECORDING = 'false';
    expect(await (await GET()).json()).toMatchObject({ deletesRecording: false });
  });

  it('says the recording is kept in transcript-only mode', async () => {
    enable();
    process.env.TEAMS_ARTIFACT_MODE = 'transcript-only';
    expect(await (await GET()).json()).toMatchObject({ deletesRecording: false });
  });
});

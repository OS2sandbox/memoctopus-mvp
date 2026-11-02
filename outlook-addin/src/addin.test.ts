import { describe, it, expect } from 'vitest';
import { needsInteraction, parseConfig, signInErrorCode } from './auth';
import { armedMessage, noLinkMessage, readArmedId, writeArmedId } from './meeting';
import type { AsyncResult, CustomProperties, OfficeApi, OrganizerItem } from './office';

const CLIENT = '33333333-3333-3333-3333-333333333333';
const TENANT = '11111111-1111-1111-1111-111111111111';

describe('parseConfig', () => {
  it('accepts the server config', () => {
    expect(parseConfig({ enabled: true, clientId: CLIENT, tenantId: TENANT, scopes: [`api://${CLIENT}/access_as_user`] }))
      .toEqual({ clientId: CLIENT, tenantId: TENANT, scopes: [`api://${CLIENT}/access_as_user`] });
  });
  it('says the add-in is off when the server says so', () => {
    expect(() => parseConfig({ enabled: false })).toThrow(/ikke slået til/);
    expect(() => parseConfig(null)).toThrow(/ikke slået til/);
  });
  it('refuses a tenant that is not one tenant id', () => {
    expect(() => parseConfig({ enabled: true, clientId: CLIENT, tenantId: 'organizations', scopes: ['x'] }))
      .toThrow(/ufuldstændig/);
  });
});

describe('needsInteraction', () => {
  it('knows the MSAL errors a pop-up can fix', () => {
    expect(needsInteraction({ name: 'InteractionRequiredAuthError' })).toBe(true);
    expect(needsInteraction({ errorCode: 'consent_required' })).toBe(true);
    expect(needsInteraction({ errorCode: 'no_account_error' })).toBe(true);
  });
  it('does not pop up for anything else', () => {
    expect(needsInteraction({ errorCode: 'network_error' })).toBe(false);
    expect(needsInteraction(null)).toBe(false);
  });
});

describe('signInErrorCode', () => {
  const msg = 'invalid_client: Error(s): 700046 - Description: AADSTS700046: Invalid Reply Address. Trace ID: 4094';
  it('names the AADSTS code an admin can look up', () => {
    expect(signInErrorCode({ errorCode: 'invalid_client', errorMessage: msg })).toBe('AADSTS700046');
    expect(signInErrorCode({ message: msg })).toBe('AADSTS700046');
  });
  it('falls back to the MSAL error code', () => {
    expect(signInErrorCode({ errorCode: 'user_cancelled', errorMessage: 'User cancelled the flow.' })).toBe('user_cancelled');
  });
  it('gives nothing it cannot vouch for', () => {
    expect(signInErrorCode(null)).toBeNull();
    expect(signInErrorCode({ errorCode: '<img src=x>' })).toBeNull();
    expect(signInErrorCode(new Error('boom'))).toBeNull();
  });
});

describe('messages', () => {
  it('tells the user to send the invitation when there is no link yet', () => {
    expect(noLinkMessage({ ok: false, reason: 'none' })).toMatch(/send invitationen/);
  });
  it('names an unknown Teams host', () => {
    expect(noLinkMessage({ ok: false, reason: 'unknown_teams_host', hosts: ['teams.evil.example'] }))
      .toContain('teams.evil.example');
  });
  it('words each arm result', () => {
    expect(armedMessage('armed', false)).toMatchObject({ tone: 'ok', text: expect.stringMatching(/optaget og transskriberet/) });
    expect(armedMessage('armed', true).text).toMatch(/^OS2taletiltekst var allerede slået til/);
    expect(armedMessage('not_organizer', false)).toMatchObject({ tone: 'warn', text: expect.stringMatching(/arrangør/) });
    expect(armedMessage('policy_blocked', false).tone).toBe('warn');
  });
});

/** A fake appointment with working custom properties. */
function fakeOutlook(initial: Record<string, unknown> = {}) {
  const store = { ...initial };
  let saved = 0;
  const props: CustomProperties = {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    remove: (k) => { delete store[k]; },
    saveAsync: (cb) => { saved += 1; cb({ status: 'succeeded', value: undefined }); },
  };
  const office = { AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' } } as unknown as OfficeApi;
  const item = {
    loadCustomPropertiesAsync: (cb: (r: AsyncResult<CustomProperties>) => void) => cb({ status: 'succeeded', value: props }),
  } as unknown as OrganizerItem;
  return { office, item, store, saves: () => saved };
}

describe('the note on the appointment', () => {
  it('remembers and forgets the armed meeting id', async () => {
    const o = fakeOutlook();
    expect(await readArmedId(o.office, o.item)).toBeNull();
    await writeArmedId(o.office, o.item, 'ol-123');
    expect(await readArmedId(o.office, o.item)).toBe('ol-123');
    await writeArmedId(o.office, o.item, null);
    expect(await readArmedId(o.office, o.item)).toBeNull();
    expect(o.saves()).toBe(2);
  });
  it('ignores a value that is not one of our ids', async () => {
    const o = fakeOutlook({ os2taletiltekstMeetingId: '../../etc' });
    expect(await readArmedId(o.office, o.item)).toBeNull();
  });
  it('carries on when custom properties cannot be loaded', async () => {
    const office = { AsyncResultStatus: { Succeeded: 'succeeded' } } as unknown as OfficeApi;
    const item = {
      loadCustomPropertiesAsync: (cb: (r: AsyncResult<CustomProperties>) => void) =>
        cb({ status: 'failed', value: null as never, error: { name: 'x', message: 'x', code: 1 } }),
    } as unknown as OrganizerItem;
    expect(await readArmedId(office, item)).toBeNull();
    await expect(writeArmedId(office, item, 'ol-1')).resolves.toBeUndefined();
  });
});

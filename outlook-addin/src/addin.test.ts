import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { getAccessToken, needsInteraction, parseConfig } from './auth';
import { armedMessage, noLinkMessage, readArmedId, writeArmedId } from './meeting';
import type { AsyncResult, CustomProperties, OfficeApi, OrganizerItem } from './office';

const CLIENT = '33333333-3333-3333-3333-333333333333';
const TENANT = '11111111-1111-1111-1111-111111111111';

describe('parseConfig', () => {
  it('accepts the server config', () => {
    expect(parseConfig({ enabled: true, clientId: CLIENT, tenantId: TENANT, scopes: [`api://${CLIENT}/access_as_user`], deletesRecording: true }))
      .toEqual({ clientId: CLIENT, tenantId: TENANT, scopes: [`api://${CLIENT}/access_as_user`], deletesRecording: true });
  });
  it('promises no deletion unless the server says it deletes the recording', () => {
    const base = { enabled: true, clientId: CLIENT, tenantId: TENANT, scopes: ['x'] };
    expect(parseConfig({ ...base, deletesRecording: false }).deletesRecording).toBe(false);
    expect(parseConfig(base).deletesRecording).toBe(false);
    expect(parseConfig({ ...base, deletesRecording: 'true' }).deletesRecording).toBe(false);
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

describe('getAccessToken', () => {
  // MSAL as the pinned CDN build exposes it; already "loaded", so no script tag.
  const app = {
    getActiveAccount: vi.fn(),
    getAllAccounts: vi.fn(),
    acquireTokenSilent: vi.fn(),
    acquireTokenPopup: vi.fn(),
  };
  const createApp = vi.fn(async () => app);
  const config = { clientId: CLIENT, tenantId: TENANT, scopes: [`api://${CLIENT}/access_as_user`], deletesRecording: true };
  const interactionRequired = Object.assign(new Error('AADSTS65001'), { name: 'InteractionRequiredAuthError' });

  beforeEach(() => {
    (globalThis as { msal?: unknown }).msal = { createNestablePublicClientApplication: createApp };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const fn of Object.values(app)) fn.mockReset();
    app.getActiveAccount.mockReturnValue(null);
    app.getAllAccounts.mockReturnValue([]);
  });
  afterAll(() => {
    delete (globalThis as { msal?: unknown }).msal;
    vi.restoreAllMocks();
  });

  it('signs in silently when it can, pinned to our tenant', async () => {
    const account = { username: 'a@kommune.dk' };
    app.getAllAccounts.mockReturnValue([account]);
    app.acquireTokenSilent.mockResolvedValue({ accessToken: 'silent-token' });

    await expect(getAccessToken(config)).resolves.toBe('silent-token');

    expect(app.acquireTokenSilent).toHaveBeenCalledWith({ scopes: config.scopes, account });
    expect(app.acquireTokenPopup).not.toHaveBeenCalled();
    expect(createApp).toHaveBeenCalledWith({
      auth: { clientId: CLIENT, authority: `https://login.microsoftonline.com/${TENANT}` },
    });
  });

  it('falls back to the Microsoft pop-up when consent or a new sign-in is needed', async () => {
    app.acquireTokenSilent.mockRejectedValue(interactionRequired);
    app.acquireTokenPopup.mockResolvedValue({ accessToken: 'popup-token' });

    await expect(getAccessToken(config)).resolves.toBe('popup-token');
    expect(app.acquireTokenPopup).toHaveBeenCalledWith({ scopes: config.scopes });
  });

  it('does not pop up for a failure a pop-up cannot fix', async () => {
    app.acquireTokenSilent.mockRejectedValue(Object.assign(new Error('offline'), { errorCode: 'network_error' }));

    await expect(getAccessToken(config)).rejects.toThrow(/Microsoft-login mislykkedes/);
    expect(app.acquireTokenPopup).not.toHaveBeenCalled();
  });

  it('says so when the pop-up does not complete either', async () => {
    app.acquireTokenSilent.mockRejectedValue(interactionRequired);
    app.acquireTokenPopup.mockRejectedValue(Object.assign(new Error('popup_window_error'), { errorCode: 'popup_window_error' }));

    await expect(getAccessToken(config)).rejects.toThrow(/Tillad pop-up-vinduet/);
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

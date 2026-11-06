import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { getBearerToken, needsInteraction, parseConfig, pickToken, secondsLeft, signInErrorCode } from './auth';
import { armedMessage, noLinkMessage, readArmedId, writeArmedId } from './meeting';
import type { AsyncResult, CustomProperties, OfficeApi, OrganizerItem } from './office';

const CLIENT = '33333333-3333-3333-3333-333333333333';
const TENANT = '11111111-1111-1111-1111-111111111111';

describe('parseConfig', () => {
  it('accepts the server config, defaulting to the access token', () => {
    expect(parseConfig({ enabled: true, clientId: CLIENT, tenantId: TENANT, scopes: [`api://${CLIENT}/access_as_user`] }))
      .toEqual({ clientId: CLIENT, tenantId: TENANT, scopes: [`api://${CLIENT}/access_as_user`], token: 'api', deletesRecording: false });
  });
  it('accepts the ID-token mode', () => {
    expect(parseConfig({ enabled: true, clientId: CLIENT, tenantId: TENANT, scopes: ['openid', 'profile'], token: 'id' }))
      .toMatchObject({ token: 'id', scopes: ['openid', 'profile'] });
  });
  it('refuses a token mode it does not know', () => {
    expect(() => parseConfig({ enabled: true, clientId: CLIENT, tenantId: TENANT, scopes: ['x'], token: 'saml' }))
      .toThrow(/ufuldstændig/);
  });
  it('accepts the server config', () => {
    expect(parseConfig({ enabled: true, clientId: CLIENT, tenantId: TENANT, scopes: [`api://${CLIENT}/access_as_user`], deletesRecording: true }))
      .toEqual({ clientId: CLIENT, tenantId: TENANT, scopes: [`api://${CLIENT}/access_as_user`], token: 'api', deletesRecording: true });
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

describe('pickToken and secondsLeft', () => {
  const base = { clientId: CLIENT, tenantId: TENANT, scopes: ['x'], deletesRecording: false };
  const res = { accessToken: 'the-access-token', idToken: 'the-id-token' };

  it('sends the token the server asked for', () => {
    expect(pickToken(res, { ...base, token: 'api' })).toBe('the-access-token');
    expect(pickToken(res, { ...base, token: 'id' })).toBe('the-id-token');
  });
  it('fails plainly when MSAL gave none back', () => {
    expect(() => pickToken({ accessToken: 'a', idToken: '' }, { ...base, token: 'id' })).toThrow(/Microsoft-login/);
  });
  it('reads how long a token has left', () => {
    const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
    expect(secondsLeft(jwt({ exp: 1_000_600 }), 1_000_000_000)).toBe(600);
    expect(secondsLeft(jwt({}), 0)).toBe(0);
    expect(secondsLeft('garbage')).toBe(0);
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

describe('getBearerToken', () => {
  // MSAL as the pinned CDN build exposes it; already "loaded", so no script tag.
  const app = {
    getActiveAccount: vi.fn(),
    getAllAccounts: vi.fn(),
    acquireTokenSilent: vi.fn(),
    acquireTokenPopup: vi.fn(),
  };
  const createApp = vi.fn(async () => app);
  const config = { clientId: CLIENT, tenantId: TENANT, scopes: [`api://${CLIENT}/access_as_user`], token: 'api' as const, deletesRecording: true };
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

    await expect(getBearerToken(config)).resolves.toBe('silent-token');

    expect(app.acquireTokenSilent).toHaveBeenCalledWith({ scopes: config.scopes, account });
    expect(app.acquireTokenPopup).not.toHaveBeenCalled();
    expect(createApp).toHaveBeenCalledWith({
      auth: { clientId: CLIENT, authority: `https://login.microsoftonline.com/${TENANT}` },
    });
  });

  it('falls back to the Microsoft pop-up when consent or a new sign-in is needed', async () => {
    app.acquireTokenSilent.mockRejectedValue(interactionRequired);
    app.acquireTokenPopup.mockResolvedValue({ accessToken: 'popup-token' });

    await expect(getBearerToken(config)).resolves.toBe('popup-token');
    expect(app.acquireTokenPopup).toHaveBeenCalledWith({ scopes: config.scopes });
  });

  it('does not pop up for a failure a pop-up cannot fix', async () => {
    app.acquireTokenSilent.mockRejectedValue(Object.assign(new Error('offline'), { errorCode: 'network_error' }));

    await expect(getBearerToken(config)).rejects.toThrow(/Microsoft-login mislykkedes/);
    expect(app.acquireTokenPopup).not.toHaveBeenCalled();
  });

  it('says so when the pop-up does not complete either', async () => {
    app.acquireTokenSilent.mockRejectedValue(interactionRequired);
    app.acquireTokenPopup.mockRejectedValue(Object.assign(new Error('popup_window_error'), { errorCode: 'popup_window_error' }));

    await expect(getBearerToken(config)).rejects.toThrow(/Tillad pop-up-vinduet/);
  });

  describe('with the add-in\'s own app (ID token)', () => {
    const idConfig = { ...config, scopes: ['openid', 'profile'], token: 'id' as const };
    const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
    const inAnHour = () => jwt(Math.floor(Date.now() / 1000) + 3600);

    it('sends the ID token, not the access token', async () => {
      const idToken = inAnHour();
      app.acquireTokenSilent.mockResolvedValue({ accessToken: 'graph-token', idToken });
      await expect(getBearerToken(idConfig)).resolves.toBe(idToken);
      expect(app.acquireTokenSilent).toHaveBeenCalledTimes(1);
    });

    it('renews a cached ID token that is about to expire', async () => {
      const fresh = inAnHour();
      app.acquireTokenSilent
        .mockResolvedValueOnce({ accessToken: 'graph-token', idToken: jwt(Math.floor(Date.now() / 1000) + 60) })
        .mockResolvedValueOnce({ accessToken: 'graph-token', idToken: fresh });
      await expect(getBearerToken(idConfig)).resolves.toBe(fresh);
      expect(app.acquireTokenSilent).toHaveBeenLastCalledWith({ scopes: idConfig.scopes, forceRefresh: true });
    });

    it('takes the ID token from the pop-up too', async () => {
      const idToken = inAnHour();
      app.acquireTokenSilent.mockRejectedValue(interactionRequired);
      app.acquireTokenPopup.mockResolvedValue({ accessToken: 'graph-token', idToken });
      await expect(getBearerToken(idConfig)).resolves.toBe(idToken);
    });
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
    // Switched on after the start, or with no window: the manual start is a condition.
    for (const late of ['armed_late', 'armed_in_progress']) {
      expect(armedMessage(late, false).text).toMatch(/Er mødet allerede i gang, så start optagelsen i Teams/);
    }
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
  const JOIN = 'https://teams.microsoft.com/meet/399000000000001?p=FaKeFaKeFaKe0001';
  const OTHER_JOIN = 'https://teams.microsoft.com/meet/399000000000002?p=FaKeFaKeFaKe0002';
  const START = new Date('2026-11-03T09:00:00.000Z');
  const NEXT_WEEK = new Date('2026-11-10T09:00:00.000Z');
  const here = { joinUrl: JOIN, start: START };

  it('remembers and forgets the armed meeting', async () => {
    const o = fakeOutlook();
    expect(await readArmedId(o.office, o.item, here)).toBeNull();
    await writeArmedId(o.office, o.item, { id: 'ol-123', ...here });
    expect(await readArmedId(o.office, o.item, here)).toBe('ol-123');
    await writeArmedId(o.office, o.item, null);
    expect(await readArmedId(o.office, o.item, here)).toBeNull();
    expect(o.saves()).toBe(2);
  });

  // The note travels with the appointment: a swapped Teams link, a copy of an
  // armed appointment, or an occurrence inheriting the series' note must not make
  // the pane say "slået til" and offer to switch off a different meeting.
  it('does not trust a note for another Teams link', async () => {
    const o = fakeOutlook();
    await writeArmedId(o.office, o.item, { id: 'ol-123', ...here });
    expect(await readArmedId(o.office, o.item, { joinUrl: OTHER_JOIN, start: START })).toBeNull();
  });

  it('does not trust a note for another start (another occurrence, a moved copy)', async () => {
    const o = fakeOutlook();
    await writeArmedId(o.office, o.item, { id: 'ol-123', ...here });
    expect(await readArmedId(o.office, o.item, { joinUrl: JOIN, start: NEXT_WEEK })).toBeNull();
  });

  it('does not trust a note when the start cannot be read', async () => {
    const o = fakeOutlook();
    await writeArmedId(o.office, o.item, { id: 'ol-123', ...here });
    expect(await readArmedId(o.office, o.item, { joinUrl: JOIN, start: null })).toBeNull();
  });

  it('does not trust a bare id from before the note carried link and start', async () => {
    const o = fakeOutlook({ os2taletiltekstMeetingId: 'ol-123' });
    expect(await readArmedId(o.office, o.item, here)).toBeNull();
  });

  it('ignores a value that is not one of our notes', async () => {
    for (const value of [
      '../../etc',
      JSON.stringify({ id: '../../etc', joinUrl: JOIN, start: START.toISOString() }),
      JSON.stringify({ id: 'ol-1', joinUrl: JOIN }),
      JSON.stringify(['ol-1', JOIN]),
      '{',
      42,
      null,
    ]) {
      const o = fakeOutlook({ os2taletiltekstMeetingId: value });
      expect(await readArmedId(o.office, o.item, here)).toBeNull();
    }
  });

  it('carries on when custom properties cannot be loaded', async () => {
    const office = { AsyncResultStatus: { Succeeded: 'succeeded' } } as unknown as OfficeApi;
    const item = {
      loadCustomPropertiesAsync: (cb: (r: AsyncResult<CustomProperties>) => void) =>
        cb({ status: 'failed', value: null as never, error: { name: 'x', message: 'x', code: 1 } }),
    } as unknown as OrganizerItem;
    expect(await readArmedId(office, item, here)).toBeNull();
    await expect(writeArmedId(office, item, { id: 'ol-1', ...here })).resolves.toBeUndefined();
  });
});

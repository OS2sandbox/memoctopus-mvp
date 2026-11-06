import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./auth', () => ({ getBearerToken: vi.fn(), loadConfig: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  armMeeting: vi.fn(),
}));

import { ApiError, armMeeting } from './api';
import { getBearerToken, loadConfig } from './auth';
import { insertMeeting } from './provider';
import type { AsyncResult, CustomProperties, OfficeApi, ProviderItem } from './office';

const JOIN = 'https://teams.microsoft.com/meet/376860952372406?p=s5vL7jGrR2tPM32ZFk';
const START = '2026-11-03T09:00:00.000Z';
/** The block Outlook's own Teams toggle writes into the invitation. */
const OUTLOOK_TEAMS_BODY = `<a id="meet_invite_block.action.join_link" href="${JOIN}">Deltag</a>`;

/** The note the add-in leaves on a meeting it armed: id, link and start. */
const note = (id: string, joinUrl = JOIN, start = START) => JSON.stringify({ id, joinUrl, start });

/** An appointment on Outlook's form. `saveAsync` is there to prove it is never called. */
function fake(body: string, { armedNote = null as string | null } = {}) {
  const notices: { type: string; message: string }[] = [];
  const store = new Map<string, unknown>(armedNote ? [['os2taletiltekstMeetingId', armedNote]] : []);
  const ok = <T>(value: T): AsyncResult<T> => ({ status: 'succeeded', value });
  const props: CustomProperties = {
    get: (k) => store.get(k),
    set: (k, v) => void store.set(k, v),
    remove: (k) => void store.delete(k),
    saveAsync: (cb) => cb({ status: 'succeeded', value: undefined }),
  };
  const saveAsync = vi.fn();
  const item = {
    start: { getAsync: (cb: (r: AsyncResult<Date>) => void) => cb(ok(new Date(START))) },
    end: { getAsync: (cb: (r: AsyncResult<Date>) => void) => cb(ok(new Date('2026-11-03T09:30:00Z'))) },
    body: { getAsync: (_c: string, cb: (r: AsyncResult<string>) => void) => cb(ok(body)) },
    loadCustomPropertiesAsync: (cb: (r: AsyncResult<CustomProperties>) => void) => cb(ok(props)),
    saveAsync,
    notificationMessages: {
      replaceAsync: (_k: string, m: { type: string; message: string }, cb?: () => void) => { notices.push(m); cb?.(); },
    },
  } as unknown as ProviderItem;
  const office = {
    CoercionType: { Html: 'html', Text: 'text' },
    AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
  } as unknown as OfficeApi;
  return { item, office, notices, saveAsync, store };
}

const ARMED = {
  id: 'ol-1', subject: 'Møde', scheduledStart: START, scheduledEnd: null, isOrganizer: true,
  armed: true, armResult: 'armed', alreadyRegistered: false, managedInDashboard: false,
};

beforeEach(() => {
  vi.mocked(loadConfig).mockResolvedValue({} as never);
  vi.mocked(getBearerToken).mockResolvedValue('token');
  vi.mocked(armMeeting).mockReset().mockResolvedValue(ARMED);
});

describe('insertMeeting ("Teams-møde med referat")', () => {
  it('arms the Teams meeting already in the invitation, without saving', async () => {
    const { item, office, notices, saveAsync, store } = fake(OUTLOOK_TEAMS_BODY);
    expect(await insertMeeting(office, item)).toBe('armed');
    expect(saveAsync).not.toHaveBeenCalled();
    expect(vi.mocked(armMeeting).mock.calls[0][0]).toBe(JOIN);
    expect(JSON.parse(store.get('os2taletiltekstMeetingId') as string)).toMatchObject({ id: 'ol-1', joinUrl: JOIN });
    expect(notices.at(-1)).toMatchObject({ type: 'informationalMessage' });
  });

  // Saving from the add-in was tried: Outlook on the web made no Teams meeting and
  // switched its own toggle off. So the command never saves.
  it('says to send and reopen when there is no Teams link yet, and neither saves nor arms', async () => {
    const { item, office, notices, saveAsync } = fake('<p>Dagsorden</p>');
    expect(await insertMeeting(office, item)).toBe('no_link');
    expect(saveAsync).not.toHaveBeenCalled();
    expect(armMeeting).not.toHaveBeenCalled();
    expect(notices.at(-1)).toMatchObject({ type: 'errorMessage' });
    expect(notices.at(-1)!.message).toMatch(/send invitationen/);
    expect(notices.every((n) => n.message.length <= 150)).toBe(true);
  });

  it('leaves a meeting it already armed alone', async () => {
    const { item, office } = fake(OUTLOOK_TEAMS_BODY, { armedNote: note('ol-1') });
    expect(await insertMeeting(office, item)).toBe('already_ours');
    expect(armMeeting).not.toHaveBeenCalled();
  });

  it('does not take a note written for another link or start as its own', async () => {
    for (const stale of [note('ol-1', 'https://teams.microsoft.com/meet/999?p=x'), note('ol-1', JOIN, '2026-11-10T09:00:00.000Z'), 'ol-1']) {
      vi.mocked(armMeeting).mockClear();
      const { item, office } = fake(OUTLOOK_TEAMS_BODY, { armedNote: stale });
      expect(await insertMeeting(office, item)).toBe('armed');
      expect(armMeeting).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses two different Teams meetings in one invitation, without saving', async () => {
    const other = OUTLOOK_TEAMS_BODY.replace(JOIN, 'https://teams.microsoft.com/meet/111?p=y');
    const { item, office, saveAsync } = fake(OUTLOOK_TEAMS_BODY + other);
    expect(await insertMeeting(office, item)).toBe('failed');
    expect(saveAsync).not.toHaveBeenCalled();
    expect(armMeeting).not.toHaveBeenCalled();
  });

  it('tells the user to sign in to OS2taletiltekst when the server has no account for them', async () => {
    vi.mocked(armMeeting).mockRejectedValue(new ApiError('Du skal logge ind på OS2taletiltekst med Microsoft.', 'no_account', 403));
    const { item, office, notices } = fake(OUTLOOK_TEAMS_BODY);
    expect(await insertMeeting(office, item)).toBe('failed');
    expect(notices.at(-1)!.message).toMatch(/Log ind i OS2taletiltekst/);
  });
});

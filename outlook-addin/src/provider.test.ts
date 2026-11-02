import { describe, it, expect } from 'vitest';
import { extractJoinLinkFromBody } from '../../src/lib/outlook/join-link-from-body';
import { insertMeeting, invitationBlock } from './provider';
import type { AsyncResult, CustomProperties, OfficeApi, ProviderItem } from './office';

const JOIN = 'https://teams.microsoft.com/meet/376860952372406?p=s5vL7jGrR2tPM32ZFk';

describe('invitationBlock', () => {
  it('is found again as the meeting\'s own link', () => {
    const html = `<p>Dagsorden</p>${invitationBlock({ joinUrl: JOIN, meetingCode: '376 860 952', passcode: 'pw' })}`;
    expect(extractJoinLinkFromBody(html)).toMatchObject({ ok: true, url: JOIN, source: 'invite-block' });
    expect(html).toContain('Møde-ID: 376 860 952');
    expect(html).toContain('optages og transskriberes');
  });

  it('escapes what it writes, and refuses a non-https link', () => {
    const html = invitationBlock({ joinUrl: JOIN, meetingCode: '<b>1</b>', passcode: '"x"' });
    expect(html).toContain('&lt;b&gt;1&lt;/b&gt;');
    expect(html).toContain('&quot;x&quot;');
    expect(() => invitationBlock({ joinUrl: 'http://teams.microsoft.com/meet/1', meetingCode: null, passcode: null })).toThrow();
  });
});

describe('insertMeeting', () => {
  function fake(body: string, armedId: string | null) {
    const notices: { type: string; message: string }[] = [];
    const store = new Map<string, unknown>(armedId ? [['os2taletiltekstMeetingId', armedId]] : []);
    const props: CustomProperties = {
      get: (k) => store.get(k),
      set: (k, v) => void store.set(k, v),
      remove: (k) => void store.delete(k),
      saveAsync: (cb) => cb({ status: 'succeeded', value: undefined }),
    };
    const ok = <T>(value: T): AsyncResult<T> => ({ status: 'succeeded', value });
    const item = {
      itemType: 'appointment',
      start: { getAsync: (cb: (r: AsyncResult<Date>) => void) => cb(ok(new Date('2026-11-03T09:00:00Z'))) },
      end: { getAsync: (cb: (r: AsyncResult<Date>) => void) => cb(ok(new Date('2026-11-03T09:30:00Z'))) },
      subject: { getAsync: (cb: (r: AsyncResult<string>) => void) => cb(ok('Møde')) },
      body: {
        getAsync: (_c: string, cb: (r: AsyncResult<string>) => void) => cb(ok(body)),
        setAsync: () => { throw new Error('must not write'); },
      },
      loadCustomPropertiesAsync: (cb: (r: AsyncResult<CustomProperties>) => void) => cb(ok(props)),
      notificationMessages: {
        replaceAsync: (_k: string, m: { type: string; message: string }, cb?: () => void) => { notices.push(m); cb?.(); },
      },
    } as unknown as ProviderItem;
    const office = {
      CoercionType: { Html: 'html', Text: 'text' },
      AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
    } as unknown as OfficeApi;
    return { item, office, notices };
  }

  const OUTLOOK_TEAMS_BODY = `<a id="meet_invite_block.action.join_link" href="${JOIN}">Deltag</a>`;

  it('never adds a second meeting to an invitation that already has a Teams link', async () => {
    const { item, office, notices } = fake(OUTLOOK_TEAMS_BODY, null);
    expect(await insertMeeting(office, item)).toBe('has_other_link');
    expect(notices.at(-1)).toMatchObject({ type: 'errorMessage' });
    expect(notices.at(-1)!.message.length).toBeLessThanOrEqual(150);
  });

  it('leaves its own meeting alone when switched on again', async () => {
    const { item, office, notices } = fake(OUTLOOK_TEAMS_BODY, 'ol-1');
    expect(await insertMeeting(office, item)).toBe('already_ours');
    expect(notices.at(-1)).toMatchObject({ type: 'informationalMessage' });
  });
});

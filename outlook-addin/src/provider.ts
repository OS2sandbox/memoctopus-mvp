/**
 * The meeting-provider button (manifest 1.1). Outlook shows an admin-installed
 * provider add-in in place of its own Teams toggle on a new meeting; switching
 * it on runs this function, which:
 *
 *   1. checks the invitation has no Teams link yet (Outlook's own, or ours),
 *   2. asks OS2taletiltekst to create a Teams meeting for the appointment's
 *      subject and times, and arm it,
 *   3. appends the join link to the invitation, the way Teams does,
 *   4. notes the meeting id on the appointment, so the pane can switch it off.
 *
 * No Outlook Teams meeting is made, so there are never two. Outcomes are shown
 * as a notification bar on the form (at most 150 characters).
 */

import { extractJoinLinkFromBody } from '../../src/lib/outlook/join-link-from-body';
import { ApiError, createMeeting, type CreatedMeetingResponse } from './api';
import { getBearerToken, loadConfig } from './auth';
import { readArmedId, readTimes, writeArmedId } from './meeting';
import type { AsyncResult, OfficeApi, ProviderItem } from './office';

const NOTICE_KEY = 'os2taletiltekst-provider';
const NOTICE_MAX = 150;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The block appended to the invitation. The join anchor carries the id Teams'
 * own invitations use, so join-link-from-body.ts finds it as the meeting's link.
 */
export function invitationBlock(meeting: Pick<CreatedMeetingResponse, 'joinUrl' | 'meetingCode' | 'passcode'>): string {
  const url = new URL(meeting.joinUrl);
  if (url.protocol !== 'https:') throw new Error('Teams-linket fra serveren er ikke https.');
  const href = escapeHtml(url.href);
  const lines = [
    '<div id="os2taletiltekst-invite">',
    '<hr>',
    '<div style="font-size:20px;font-weight:600">Microsoft Teams-møde</div>',
    `<div><b>Deltag:</b> <a id="meet_invite_block.action.join_link" href="${href}">${href}</a></div>`,
    ...(meeting.meetingCode ? [`<div>Møde-ID: ${escapeHtml(meeting.meetingCode)}</div>`] : []),
    ...(meeting.passcode ? [`<div>Adgangskode: ${escapeHtml(meeting.passcode)}</div>`] : []),
    '<div style="color:#616161;font-size:12px">Mødet optages og transskriberes, så OS2taletiltekst kan lave et referat.</div>',
    '<hr>',
    '</div>',
  ];
  return lines.join('');
}

function clip(text: string): string {
  return text.length > NOTICE_MAX ? `${text.slice(0, NOTICE_MAX - 1)}…` : text;
}

function promised<T>(run: (cb: (res: AsyncResult<T>) => void) => void, office: OfficeApi): Promise<T> {
  return new Promise((resolve, reject) => {
    run((res) => {
      if (res.status === office.AsyncResultStatus.Succeeded) resolve(res.value);
      else reject(new Error(res.error?.message ?? 'ukendt fejl'));
    });
  });
}

function notify(item: ProviderItem, tone: 'progress' | 'ok' | 'error', message: string): Promise<void> {
  const text = clip(message);
  const payload = tone === 'progress'
    ? { type: 'progressIndicator' as const, message: text }
    : tone === 'error'
      ? { type: 'errorMessage' as const, message: text }
      : { type: 'informationalMessage' as const, message: text, icon: 'Icon.16x16', persistent: false };
  return new Promise((resolve) => {
    try {
      item.notificationMessages.replaceAsync(NOTICE_KEY, payload, () => resolve());
    } catch (err) {
      console.warn('[os2taletiltekst] provider: notification refused:', err);
      resolve();
    }
  });
}

function errorText(err: unknown): string {
  if (err instanceof ApiError && ['no_account', 'reauth_required', 'consent_required'].includes(err.code)) {
    return `${err.message} Log ind i OS2taletiltekst med Microsoft og prøv igen.`;
  }
  return err instanceof Error ? err.message : String(err);
}

export type ProviderOutcome = 'created' | 'already_ours' | 'has_other_link' | 'failed';

export async function insertMeeting(office: OfficeApi, item: ProviderItem): Promise<ProviderOutcome> {
  await notify(item, 'progress', 'Opretter Teams-møde med OS2taletiltekst …');
  try {
    const [body, armedId] = await Promise.all([
      promised<string>((cb) => item.body.getAsync(office.CoercionType.Html, cb), office),
      readArmedId(office, item),
    ]);
    const existing = extractJoinLinkFromBody(body);
    if (existing.ok || existing.reason === 'multiple_distinct') {
      if (armedId) {
        await notify(item, 'ok', 'Mødet har allerede et Teams-møde fra OS2taletiltekst.');
        return 'already_ours';
      }
      await notify(item, 'error', 'Mødet har allerede et Teams-link. Fjern det, før OS2taletiltekst opretter et nyt, så der ikke bliver to møder.');
      return 'has_other_link';
    }

    const times = await readTimes(office, item);
    if (!times) throw new Error('Mødets start og slut kunne ikke læses.');
    const subject = await promised<string>((cb) => item.subject.getAsync(cb), office).catch(() => '');

    const token = await getBearerToken(await loadConfig());
    const created = await createMeeting(subject, times, token);

    await promised<void>(
      (cb) => item.body.setAsync(body + invitationBlock(created), { coercionType: office.CoercionType.Html }, cb),
      office,
    );
    await writeArmedId(office, item, created.id);
    console.info('[os2taletiltekst] provider: created and armed', created.id, created.armResult);
    await notify(item, 'ok', created.armed
      ? 'Teams-møde tilføjet. Det optages og transskriberes, og referatet kommer i OS2taletiltekst.'
      : 'Teams-møde tilføjet, men optagelse kunne ikke slås til automatisk. Start transskription i Teams.');
    return 'created';
  } catch (err) {
    console.warn('[os2taletiltekst] provider failed:', err);
    await notify(item, 'error', `OS2taletiltekst kunne ikke oprette mødet: ${errorText(err)}`);
    return 'failed';
  }
}

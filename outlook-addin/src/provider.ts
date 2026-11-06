/**
 * The add-in's menu command, "Teams-møde med referat" (manifest 1.1, the one
 * function command a meeting-provider add-in may have). It switches OS2taletiltekst
 * on for the Teams meeting Outlook's own toggle made, without opening the pane:
 *
 *   1. reads the invitation's Teams link,
 *   2. arms that meeting, exactly as the pane's "Slå til" does,
 *   3. notes the meeting on the appointment, so the pane can switch it off.
 *
 * On the web and in new Outlook the link is only there once the invitation has
 * been sent, so before that it says to send and reopen. Saving the appointment
 * from the add-in does not help: Outlook on the web then creates no Teams meeting
 * and switches its own toggle off (tried 2026-11-06).
 *
 * It never makes a Teams meeting of its own: Outlook shows its Join button only
 * for meetings made by its own toggle, so those are the ones worth arming.
 * Outcomes are shown in the form's notification bar (at most 150 characters).
 */

import { ApiError, armMeeting } from './api';
import { getBearerToken, loadConfig } from './auth';
import { armedMessage, noLinkMessage, readArmedId, readJoinLink, readTimes, writeArmedId } from './meeting';
import type { OfficeApi, ProviderItem } from './office';

const NOTICE_KEY = 'os2taletiltekst-provider';
const NOTICE_MAX = 150;

/** noLinkMessage('none'), short enough for the notification bar. */
const NO_LINK_NOTICE = 'Mødet har endnu intet Teams-link. Slå "Teams-møde" til, send invitationen, og åbn så mødet og slå OS2taletiltekst til.';

function clip(text: string): string {
  return text.length > NOTICE_MAX ? `${text.slice(0, NOTICE_MAX - 1)}…` : text;
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
      console.warn('[os2taletiltekst] menu command: notification refused:', err);
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

export type ProviderOutcome = 'armed' | 'already_ours' | 'no_link' | 'failed';

export async function insertMeeting(office: OfficeApi, item: ProviderItem): Promise<ProviderOutcome> {
  await notify(item, 'progress', 'Slår OS2taletiltekst til …');
  try {
    const link = await readJoinLink(office, item);
    if (!link.ok) {
      const message = link.reason === 'none' ? NO_LINK_NOTICE : noLinkMessage(link);
      await notify(item, 'error', message);
      return link.reason === 'none' ? 'no_link' : 'failed';
    }

    const joinUrl = link.url;
    const times = await readTimes(office, item);
    if (await readArmedId(office, item, { joinUrl, start: times?.start ?? null })) {
      await notify(item, 'ok', 'OS2taletiltekst er allerede slået til for mødet.');
      return 'already_ours';
    }

    const token = await getBearerToken(await loadConfig());
    const result = await armMeeting(joinUrl, times, token);
    if (result.managedInDashboard) {
      await notify(item, 'ok', 'OS2taletiltekst er allerede slået til for mødet fra OS2taletiltekst.');
      return 'already_ours';
    }
    if (result.armed || result.armResult === 'not_organizer' || result.armResult === 'policy_blocked') {
      await writeArmedId(office, item, times ? { id: result.id, joinUrl, start: times.start } : null);
    }
    const message = armedMessage(result.armResult, result.alreadyRegistered);
    console.info('[os2taletiltekst] menu command: armed', result.id, result.armResult);
    await notify(item, message.tone === 'ok' ? 'ok' : 'error', message.text);
    return result.armed ? 'armed' : 'failed';
  } catch (err) {
    console.warn('[os2taletiltekst] menu command failed:', err);
    await notify(item, 'error', `OS2taletiltekst kunne ikke slås til: ${errorText(err)}`);
    return 'failed';
  }
}

/**
 * The task pane's behaviour: reads the meeting's Teams link from the invitation,
 * signs in with NAA, and asks OS2taletiltekst to switch the meeting on (or off
 * again). Everything after that is the server's Graph pipeline. Nothing from the
 * meeting body is ever written into the page as HTML: only the extracted link
 * leaves this pane. taskpane.ts starts it; the tests drive it directly.
 */

import { ApiError, armMeeting, disarmMeeting } from './api';
import { getBearerToken, loadConfig, type AddinConfig } from './auth';
import {
  NO_LINK_AFTER_SAVE,
  armedMessage,
  noLinkMessage,
  readArmedId,
  readIsRecurring,
  readJoinLink,
  readTimes,
  saveAndReadJoinLink,
  writeArmedId,
} from './meeting';
import { getOffice, type OfficeApi, type OrganizerItem } from './office';

type Tone = 'ok' | 'warn' | 'error' | 'info';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} mangler i taskpane.html`);
  return el;
}

function say(text: string, tone: Tone): void {
  const status = $('status');
  status.textContent = text;
  status.dataset.tone = tone;
}

function show(id: string, visible: boolean): void {
  $(id).hidden = !visible;
}

function busy(on: boolean): void {
  for (const id of ['arm', 'disarm']) ($(id) as HTMLButtonElement).disabled = on;
}

function errorText(err: unknown): string {
  if (err instanceof ApiError && (err.code === 'no_account' || err.code === 'reauth_required' || err.code === 'consent_required')) {
    return `${err.message} Åbn OS2taletiltekst og log ind med Microsoft, og prøv så igen.`;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface State {
  office: OfficeApi;
  item: OrganizerItem;
  joinUrl: string | null;
  armedId: string | null;
  config: AddinConfig | null;
  /** No Teams link yet: "Slå til" saves the meeting first, so Outlook makes one. */
  canSave?: boolean;
}

function render(state: State): void {
  show('arm', state.armedId == null && (state.joinUrl != null || state.canSave === true));
  show('disarm', state.armedId != null);
}

/** What happens to the recording, as this server is set up. Nothing until it is known. */
function renderRecordingNote(config: AddinConfig | null): void {
  $('recording-note').textContent = !config
    ? ''
    : config.deletesRecording
      ? 'Optagelsen slettes i Teams, når du har åbnet mødet i OS2taletiltekst, og transskriptionen er gemt.'
      : 'OS2taletiltekst sletter ikke optagelsen. Den bliver i Teams efter jeres egne regler for optagelser.';
}

export async function arm(state: State): Promise<void> {
  if (!state.joinUrl && !state.canSave) return;
  busy(true);
  try {
    if (!state.joinUrl) {
      say('Gemmer mødet, så Teams laver linket …', 'info');
      const link = await saveAndReadJoinLink(state.office, state.item);
      if (!link.ok) {
        say(link.reason === 'none' ? NO_LINK_AFTER_SAVE : noLinkMessage(link), link.reason === 'none' ? 'warn' : 'error');
        return;
      }
      state.joinUrl = link.url;
      state.canSave = false;
      show('series', await readIsRecurring(state.office, state.item));
    }
    say('Slår OS2taletiltekst til …', 'info');
    state.config ??= await loadConfig();
    const token = await getBearerToken(state.config);
    const joinUrl = state.joinUrl;
    const times = await readTimes(state.office, state.item);
    const result = await armMeeting(joinUrl, times, token);
    if (result.managedInDashboard) {
      // Not ours to switch off: it was registered in the dashboard and lives there.
      say('OS2taletiltekst er allerede slået til for mødet fra OS2taletiltekst. Slå det fra der, hvis det skal.', 'ok');
      return;
    }
    const message = armedMessage(result.armResult, result.alreadyRegistered);
    say(message.text, message.tone);
    if (result.armed || result.armResult === 'not_organizer' || result.armResult === 'policy_blocked') {
      state.armedId = result.id;
      // Without a start the note could not be told apart from another occurrence's,
      // so none is kept: reopening the pane then offers "Slå til" again.
      await writeArmedId(state.office, state.item, times ? { id: result.id, joinUrl, start: times.start } : null);
    }
  } catch (err) {
    say(errorText(err), 'error');
  } finally {
    busy(false);
    render(state);
  }
}

export async function disarm(state: State): Promise<void> {
  if (!state.armedId) return;
  busy(true);
  say('Slår OS2taletiltekst fra …', 'info');
  try {
    state.config ??= await loadConfig();
    const token = await getBearerToken(state.config);
    try {
      const result = await disarmMeeting(state.armedId, token);
      say(
        result.disarmed
          ? 'OS2taletiltekst er slået fra for mødet.'
          : 'OS2taletiltekst er slået fra, men mødets optagelsesindstillinger i Teams kunne ikke sættes tilbage. Ret dem under Mødeindstillinger.',
        result.disarmed ? 'ok' : 'warn',
      );
    } catch (err) {
      // Already gone on the server (switched off in the dashboard): only the note is stale.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
      say('OS2taletiltekst var allerede slået fra for mødet.', 'ok');
    }
    state.armedId = null;
    await writeArmedId(state.office, state.item, null);
  } catch (err) {
    say(errorText(err), 'error');
  } finally {
    busy(false);
    render(state);
  }
}

export async function start(): Promise<void> {
  const office = getOffice();
  if (!office) {
    say('Siden skal åbnes fra Outlook.', 'error');
    return;
  }
  await office.onReady();
  const item = office.context.mailbox.item;
  if (!item) {
    say('Åbn et møde i Outlook, og tryk på OS2taletiltekst igen.', 'error');
    return;
  }
  if (!office.context.requirements.isSetSupported('NestedAppAuth', '1.1')) {
    say(
      'Denne version af Outlook understøtter ikke det login, OS2taletiltekst bruger. ' +
        'Brug Outlook på nettet eller det nye Outlook, eller indsæt mødelinket i OS2taletiltekst.',
      'error',
    );
    return;
  }

  const state: State = { office, item, joinUrl: null, armedId: null, config: null };
  $('arm').addEventListener('click', () => void arm(state));
  $('disarm').addEventListener('click', () => void disarm(state));

  try {
    const [link, times, recurring, config] = await Promise.all([
      readJoinLink(office, item),
      readTimes(office, item),
      readIsRecurring(office, item),
      // Here only for the note. A failure is reported when a button needs the
      // config and loads it again.
      loadConfig().catch(() => null),
    ]);
    state.config = config;
    renderRecordingNote(config);
    if (link.ok) {
      state.joinUrl = link.url;
      // Arming sets automatic recording on the one Teams meeting a series shares,
      // so Teams records every occurrence. Said up front, not refused.
      show('series', recurring);
      const armedId = await readArmedId(office, item, { joinUrl: link.url, start: times?.start ?? null });
      state.armedId = armedId;
      say(
        armedId
          ? 'OS2taletiltekst er slået til for mødet.'
          : 'Mødet har et Teams-link. Slå OS2taletiltekst til, så bliver mødet optaget og transskriberet.',
        armedId ? 'ok' : 'info',
      );
    } else {
      state.canSave = link.reason === 'none';
      say(noLinkMessage(link), link.reason === 'none' ? 'warn' : 'error');
    }
  } catch (err) {
    say(`Mødet kunne ikke læses: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
  render(state);
}

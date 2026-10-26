/**
 * OS2taletiltekst for Outlook: the task pane behind the button on the
 * organizer's meeting form.
 *
 * It reads the meeting's Teams link from the invitation, signs in with NAA, and
 * asks OS2taletiltekst to switch the meeting on (or off again). Everything after
 * that is the server's Graph pipeline. Nothing from the meeting body is ever
 * written into the page as HTML: only the extracted link leaves this pane.
 */

import { ApiError, armMeeting, disarmMeeting } from './api';
import { getAccessToken, loadConfig, type AddinConfig } from './auth';
import { armedMessage, noLinkMessage, readArmedId, readJoinLink, readTimes, writeArmedId } from './meeting';
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

interface State {
  office: OfficeApi;
  item: OrganizerItem;
  joinUrl: string | null;
  armedId: string | null;
  config: AddinConfig | null;
}

function render(state: State): void {
  show('arm', state.joinUrl != null && state.armedId == null);
  show('disarm', state.armedId != null);
}

async function arm(state: State): Promise<void> {
  if (!state.joinUrl) return;
  busy(true);
  say('Slår OS2taletiltekst til …', 'info');
  try {
    state.config ??= await loadConfig();
    const token = await getAccessToken(state.config);
    const result = await armMeeting(state.joinUrl, await readTimes(state.office, state.item), token);
    if (result.managedInDashboard) {
      // Not ours to switch off: it was registered in the dashboard and lives there.
      say('OS2taletiltekst er allerede slået til for mødet fra OS2taletiltekst. Slå det fra der, hvis det skal.', 'ok');
      return;
    }
    const message = armedMessage(result.armResult, result.alreadyRegistered);
    say(message.text, message.tone);
    if (result.armed || result.armResult === 'not_organizer' || result.armResult === 'policy_blocked') {
      state.armedId = result.id;
      await writeArmedId(state.office, state.item, result.id);
    }
  } catch (err) {
    say(errorText(err), 'error');
  } finally {
    busy(false);
    render(state);
  }
}

async function disarm(state: State): Promise<void> {
  if (!state.armedId) return;
  busy(true);
  say('Slår OS2taletiltekst fra …', 'info');
  try {
    state.config ??= await loadConfig();
    const token = await getAccessToken(state.config);
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

async function start(): Promise<void> {
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
    const [link, armedId] = await Promise.all([readJoinLink(office, item), readArmedId(office, item)]);
    state.armedId = armedId;
    if (link.ok) {
      state.joinUrl = link.url;
      say(
        armedId
          ? 'OS2taletiltekst er slået til for mødet.'
          : 'Mødet har et Teams-link. Slå OS2taletiltekst til, så bliver mødet optaget og transskriberet.',
        armedId ? 'ok' : 'info',
      );
    } else {
      say(noLinkMessage(link), link.reason === 'none' ? 'warn' : 'error');
    }
  } catch (err) {
    say(`Mødet kunne ikke læses: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
  render(state);
}

void start();

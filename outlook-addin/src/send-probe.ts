/**
 * TEST ONLY: what an OnAppointmentSend handler can see, for the test add-in
 * (manifest-test.xml). It answers the three questions arming-on-Send depends on:
 *
 *   1. Does Outlook run the send event at all for this meeting form? (If it
 *      does not, the meeting is simply sent and no dialog appears.)
 *   2. Is the Teams link already in the body when Send is pressed, or does it
 *      only arrive a moment later?
 *   3. Can we get a token without a pop-up inside the event?
 *
 * It arms nothing and sends nothing to the server except the config fetch. It
 * reports in Outlook's own Smart Alerts dialog (send mode PromptUser), where the
 * user chooses "Send anyway".
 */

import { extractJoinLinkFromBody } from '../../src/lib/outlook/join-link-from-body';
import { getAccessTokenSilently, loadConfig, signInErrorCode } from './auth';
import type { AsyncResult } from './office';

/** How long to wait before reading the body a second time. Short: past five
 *  seconds Outlook shows its "taking longer than expected" dialog. */
export const SECOND_READ_DELAY_MS = 2000;

export interface BodyLook {
  /** The extractor's verdict, as the real arming code would see it. */
  link: 'found' | 'none' | 'other';
  /** Any Teams host in the raw text, even where the extractor finds no link. */
  mentionsTeams: boolean;
  length: number;
}

export type BodyRead = BodyLook | { error: string };

export type TokenCheck = { ok: true } | { ok: false; code: string | null } | { skipped: string };

export interface ProbeResult {
  host: string;
  first: BodyRead;
  second: BodyRead | null;
  token: TokenCheck;
  elapsedMs: number;
}

export function lookAtBody(body: string): BodyLook {
  const result = extractJoinLinkFromBody(body);
  return {
    link: result.ok ? 'found' : result.reason === 'none' ? 'none' : 'other',
    mentionsTeams: /teams\.(microsoft|live)\.com/i.test(body),
    length: body.length,
  };
}

function describeRead(read: BodyRead): string {
  if ('error' in read) return `kunne ikke læses (${read.error})`;
  const verdict = read.link === 'found' ? 'JA' : read.link === 'none' ? 'nej' : 'ugyldigt link';
  return `${verdict} (teams-adresse i teksten: ${read.mentionsTeams ? 'ja' : 'nej'}, ${read.length} tegn)`;
}

function describeToken(token: TokenCheck): string {
  if ('skipped' in token) return `ikke prøvet (${token.skipped})`;
  return token.ok ? 'OK' : `fejlede${token.code ? ` (${token.code})` : ''}`;
}

/** The dialog text: plain lines, and the same as Markdown where Outlook supports it. */
export function probeReport(result: ProbeResult): { text: string; markdown: string } {
  const lines = [
    'TEST af OS2taletiltekst: send-hændelsen kørte.',
    `Teams-link ved Send: ${describeRead(result.first)}`,
    ...(result.second ? [`Efter ${SECOND_READ_DELAY_MS / 1000} sek.: ${describeRead(result.second)}`] : []),
    `Login uden pop-up: ${describeToken(result.token)}`,
    `Outlook: ${result.host}, ${result.elapsedMs} ms.`,
    'Vælg "Send alligevel" for at sende invitationen.',
  ];
  const clip = (s: string) => (s.length > 500 ? `${s.slice(0, 497)}...` : s);
  return {
    text: clip(lines.join(' ')),
    markdown: clip(lines.map((l) => l.replace(/([*_\\[\]])/g, '\\$1')).join('\n\n')),
  };
}

// --- The Office side ------------------------------------------------------------

interface SendEvent {
  completed(options: { allowEvent: boolean; errorMessage?: string; errorMessageMarkdown?: string }): void;
}

interface ProbeOffice {
  CoercionType: { Html: string };
  AsyncResultStatus: { Succeeded: string };
  context: {
    mailbox: {
      item: { body: { getAsync(coercion: string, cb: (res: AsyncResult<string>) => void): void } } | null;
      diagnostics?: { hostName?: string; hostVersion?: string };
    };
    requirements: { isSetSupported(name: string, minVersion?: string): boolean };
  };
}

function readHtml(office: ProbeOffice): Promise<BodyRead> {
  return new Promise((resolve) => {
    const item = office.context.mailbox.item;
    if (!item) return resolve({ error: 'intet møde' });
    try {
      item.body.getAsync(office.CoercionType.Html, (res) => {
        if (res.status === office.AsyncResultStatus.Succeeded) resolve(lookAtBody(res.value ?? ''));
        else resolve({ error: res.error?.message ?? 'ukendt fejl' });
      });
    } catch (err) {
      resolve({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

async function checkToken(office: ProbeOffice): Promise<TokenCheck> {
  // Classic Outlook on Windows runs the handler in a JavaScript-only runtime: no
  // DOM to load MSAL into, and no page origin for the config fetch.
  if (typeof document === 'undefined') return { skipped: 'ingen browser-runtime' };
  if (!office.context.requirements.isSetSupported('NestedAppAuth', '1.1')) return { skipped: 'NAA mangler' };
  try {
    await getAccessTokenSilently(await loadConfig());
    return { ok: true };
  } catch (err) {
    console.warn('[os2taletiltekst] send probe: silent sign-in failed:', err);
    return { ok: false, code: signInErrorCode(err) };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSendProbe(office: ProbeOffice, event: SendEvent): Promise<void> {
  const started = Date.now();
  let result: ProbeResult;
  try {
    const diag = office.context.mailbox.diagnostics;
    const host = `${diag?.hostName ?? '?'} ${diag?.hostVersion ?? ''}`.trim();
    const tokenCheck = checkToken(office);
    const first = await readHtml(office);
    const second = 'error' in first || first.link !== 'found'
      ? await sleep(SECOND_READ_DELAY_MS).then(() => readHtml(office))
      : null;
    result = { host, first, second, token: await tokenCheck, elapsedMs: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    event.completed({ allowEvent: false, errorMessage: `TEST af OS2taletiltekst fejlede: ${message}`.slice(0, 500) });
    return;
  }
  console.info('[os2taletiltekst] send probe:', result);
  const report = probeReport(result);
  // allowEvent false is what makes Outlook show the dialog; PromptUser lets the
  // user send anyway. The real handler will always allow the send.
  event.completed({ allowEvent: false, errorMessage: report.text, errorMessageMarkdown: report.markdown });
}

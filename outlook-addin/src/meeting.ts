/**
 * Reading the meeting: its Teams link from the body (the same extractor the
 * tests pin down, src/lib/outlook/join-link-from-body.ts), and the add-in's own
 * note on the appointment of which OS2taletiltekst meeting it armed.
 */

import { extractJoinLinkFromBody, type JoinLinkFromBody } from '../../src/lib/outlook/join-link-from-body';
import type { CustomProperties, OfficeApi, OrganizerItem } from './office';

function readBody(office: OfficeApi, item: OrganizerItem, coercion: string): Promise<string> {
  return new Promise((resolve, reject) => {
    item.body.getAsync(coercion, (res) => {
      if (res.status === office.AsyncResultStatus.Succeeded) resolve(res.value ?? '');
      else reject(new Error(res.error?.message ?? 'ukendt fejl'));
    });
  });
}

/**
 * Reads the body as HTML and extracts the link. Falls back to the plain-text body
 * only when the HTML read itself fails. Not on `none`: Outlook's text rendering can
 * surface content the HTML pass deliberately ignores (comments, hidden elements),
 * so a text fallback would re-admit exactly the links the HTML pass refused.
 */
export async function readJoinLink(office: OfficeApi, item: OrganizerItem): Promise<JoinLinkFromBody> {
  let htmlError: unknown;
  try {
    return extractJoinLinkFromBody(await readBody(office, item, office.CoercionType.Html));
  } catch (err) {
    htmlError = err;
  }
  try {
    return extractJoinLinkFromBody(await readBody(office, item, office.CoercionType.Text));
  } catch {
    throw htmlError;
  }
}

/** Danish text for a body without one usable Teams link. */
export function noLinkMessage(result: Exclude<JoinLinkFromBody, { ok: true }>): string {
  switch (result.reason) {
    case 'none':
      // In new Outlook and on the web the link only lands in the body once the
      // invitation is sent, so that is the step to name.
      return 'Mødet har endnu intet Teams-link. Slå "Teams-møde" til, send invitationen, og åbn så mødet og OS2taletiltekst igen.';
    case 'invalid':
      return 'Mødet har et link, der ligner et Teams-link, men det er ufuldstændigt. Indsæt det oprindelige link fra Teams igen.';
    case 'unknown_teams_host':
      return `Mødets link peger på en adresse, OS2taletiltekst ikke kender som Teams (${result.hosts.join(', ')}).`;
    case 'multiple_distinct':
      return 'Mødet har links til flere forskellige Teams-møder. Der må kun være ét.';
    case 'too_large':
      return 'Mødets tekst er for lang til at blive læst. Fjern indsatte billeder eller lange bilag fra teksten.';
  }
}

/** Danish text for what arming did, from the server's `armResult`. */
export function armedMessage(armResult: string, alreadyRegistered: boolean): { text: string; tone: 'ok' | 'warn' } {
  const prefix = alreadyRegistered ? 'OS2taletiltekst var allerede slået til. ' : '';
  switch (armResult) {
    case 'armed':
      return {
        text: `${prefix}Mødet bliver optaget og transskriberet i Teams. Åbn det i OS2taletiltekst efter mødet for at få referatet.`,
        tone: 'ok',
      };
    case 'armed_in_progress':
    case 'armed_late':
      return {
        text: `${prefix}OS2taletiltekst er slået til. Er mødet allerede i gang, så start optagelsen i Teams (Flere handlinger → Optag og transskriber → Start optagelse). Det, der optages, hentes efter mødet.`,
        tone: 'ok',
      };
    case 'not_organizer':
      return {
        text: 'Du er ikke mødets arrangør, så OS2taletiltekst kan ikke slå optagelse til. Arrangøren skal starte transskription i Teams.',
        tone: 'warn',
      };
    case 'policy_blocked':
      return {
        text: 'Jeres Teams-opsætning tillader ikke automatisk optagelse af mødet. Start transskription i Teams under mødet.',
        tone: 'warn',
      };
    default:
      return { text: `${prefix}OS2taletiltekst er slået til.`, tone: 'ok' };
  }
}

function readTime(office: OfficeApi, time: OrganizerItem['start']): Promise<Date | null> {
  return new Promise((resolve) => {
    try {
      time.getAsync((res) =>
        resolve(res.status === office.AsyncResultStatus.Succeeded && res.value instanceof Date ? res.value : null),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * The appointment's own start and end, which for a recurring series is the
 * occurrence being edited. Null when either cannot be read.
 */
export async function readTimes(office: OfficeApi, item: OrganizerItem): Promise<{ start: Date; end: Date } | null> {
  const [start, end] = await Promise.all([readTime(office, item.start), readTime(office, item.end)]);
  return start && end && end > start ? { start, end } : null;
}

/**
 * Whether the appointment is a recurring series or an occurrence of one. Needs
 * Mailbox 1.7; an older Outlook, or a failed read, counts as not recurring.
 */
export function readIsRecurring(office: OfficeApi, item: OrganizerItem): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      if (item.seriesId) return resolve(true);
      if (!item.recurrence) return resolve(false);
      item.recurrence.getAsync((res) =>
        resolve(res.status === office.AsyncResultStatus.Succeeded && res.value != null),
      );
    } catch {
      resolve(false);
    }
  });
}

// --- The add-in's note on the appointment ---------------------------------------
//
// Which OS2taletiltekst meeting this appointment was armed as, so reopening the
// pane can say "slået til" and offer "Slå fra". Custom properties are private to
// this add-in and travel with the appointment, which is also their danger: the
// organizer can swap the Teams link, copy an armed appointment, or open an
// occurrence that inherited the series' properties. So the note records the link
// and start it was written for, and is trusted only while both still match;
// otherwise "Slå fra" would switch off a different meeting.
//
// Best effort throughout: without a trusted note the pane offers "Slå til" again,
// which is idempotent on the server (it finds the meeting's row and re-arms it).

/** The property's name, unchanged from when it held a bare meeting id. */
const NOTE_KEY = 'os2taletiltekstMeetingId';

const MEETING_ID_RE = /^[\w-]{1,80}$/;

/** The appointment as the pane reads it now. */
export interface MeetingNow {
  joinUrl: string;
  start: Date | null;
}

/** What the note says, stored as JSON. */
interface ArmedNote {
  id: string;
  joinUrl: string;
  start: string;
}

/** The note, or null for anything else: nothing, garbage, or a bare id an earlier
 *  version wrote, which says nothing about which meeting it was for. */
function parseNote(value: unknown): ArmedNote | null {
  if (typeof value !== 'string') return null;
  let note: unknown;
  try {
    note = JSON.parse(value);
  } catch {
    return null;
  }
  const { id, joinUrl, start } = (note ?? {}) as Record<string, unknown>;
  if (typeof id !== 'string' || !MEETING_ID_RE.test(id)) return null;
  if (typeof joinUrl !== 'string' || typeof start !== 'string') return null;
  return { id, joinUrl, start };
}

function loadProps(office: OfficeApi, item: OrganizerItem): Promise<CustomProperties | null> {
  return new Promise((resolve) => {
    try {
      item.loadCustomPropertiesAsync((res) =>
        resolve(res.status === office.AsyncResultStatus.Succeeded ? res.value : null),
      );
    } catch {
      resolve(null);
    }
  });
}

function save(office: OfficeApi, props: CustomProperties): Promise<void> {
  return new Promise((resolve) => {
    try {
      props.saveAsync(() => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * The OS2taletiltekst meeting this appointment was armed as, if the note was
 * written for this very link and start. A start that cannot be read matches
 * nothing: it is what tells the occurrences of a series apart.
 */
export async function readArmedId(office: OfficeApi, item: OrganizerItem, now: MeetingNow): Promise<string | null> {
  const note = parseNote((await loadProps(office, item))?.get(NOTE_KEY));
  if (!note || !now.start) return null;
  return note.joinUrl === now.joinUrl && note.start === now.start.toISOString() ? note.id : null;
}

/** Notes the armed meeting with the link and start it was armed for, or removes the note. */
export async function writeArmedId(
  office: OfficeApi,
  item: OrganizerItem,
  armed: { id: string; joinUrl: string; start: Date } | null,
): Promise<void> {
  const props = await loadProps(office, item);
  if (!props) return;
  if (armed) {
    const note: ArmedNote = { id: armed.id, joinUrl: armed.joinUrl, start: armed.start.toISOString() };
    props.set(NOTE_KEY, JSON.stringify(note));
  } else {
    props.remove(NOTE_KEY);
  }
  await save(office, props);
}

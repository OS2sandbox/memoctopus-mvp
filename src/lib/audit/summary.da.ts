// One clear Danish sentence per audit event, for the log viewer. Pure and
// client-safe. Only the actor's name snapshot, the event type, the outcome and a
// few whitelisted detail fields (version, format, counts, enum codes) are used:
// never free text from `details`. A template's name comes from the changelog
// (templateName) and is shown only for central template events.
//
// `SENTENCES` is an exhaustive Record over EventType: a new event type without a
// sentence is a compile error.
import type { EventType } from './events';
import { isEventType } from './events';
import { capabilityLabels, roleLabels } from '@/lib/authz/labels.da';
import type { Capability, RoleKey } from '@/lib/authz/types';
import { eventTypeLabel } from './labels.da';

export interface SummarisableEvent {
  eventType: string;
  outcome: string;
  source?: string;
  actorUserId?: string | null;
  actorName?: string | null;
  details?: Record<string, unknown> | null;
  templateName?: string | null;
}

interface Ctx {
  /** The actor as it reads at the start of a sentence. */
  actor: string;
  failed: boolean;
  details: Record<string, unknown>;
  templateName: string | null;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function version(d: Record<string, unknown>): string {
  const v = num(d.version);
  return v === null ? '' : ` (version ${v})`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('da-DK')} ${n === 1 ? one : many}`;
}

function roleName(v: unknown): string {
  return typeof v === 'string' && has(roleLabels, v) ? `»${roleLabels[v as RoleKey]}«` : 'en rolle';
}

function centralTemplate(c: Ctx): string {
  return c.templateName ? `den centrale skabelon »${c.templateName}«` : 'en central skabelon';
}

const METHOD_TEXT: Record<string, string> = {
  password: ' med adgangskode',
  microsoft: ' med Microsoft',
  oidc: ' via single sign-on',
};

const LOGIN_FAILED_REASON: Record<string, string> = {
  invalid_credentials: 'forkerte loginoplysninger',
  oauth_error: 'fejl hos login-udbyderen',
  account_not_linked: 'kontoen er ikke koblet til en bruger',
  rate_limited: 'for mange forsøg',
};

const ORIGIN_TEXT: Record<string, string> = { live: 'live optagelse', upload: 'upload', bot: 'mødebot' };

const SENTENCES: Record<EventType, (c: Ctx) => string> = {
  'auth.login': (c) => `${c.actor} loggede ind${METHOD_TEXT[String(c.details.method)] ?? ''}`,
  'auth.logout': (c) => `${c.actor} loggede ud`,
  // The attempt has no (trusted) user, so there is no actor in the sentence.
  'auth.login_failed': (c) => {
    const reason = LOGIN_FAILED_REASON[String(c.details.reason)];
    return `Mislykket login-forsøg${reason ? ` (${reason})` : ''}`;
  },
  'authz.denied': (c) => {
    const required = String(c.details.required);
    const label = has(capabilityLabels, required) ? capabilityLabels[required as Capability] : null;
    return `${c.actor} fik adgang nægtet${label ? ` til »${label}«` : ''}`;
  },

  'template.create': (c) => `${c.actor} oprettede en skabelon`,
  'template.update': (c) => `${c.actor} ændrede en skabelon`,
  'template.delete': (c) => `${c.actor} slettede en skabelon`,
  'template.share': (c) => `${c.actor} delte en skabelon via link`,
  'template.import': (c) => `${c.actor} importerede en skabelon fra et link`,

  'central_template.create': (c) => `${c.actor} oprettede ${centralTemplate(c)}`,
  'central_template.update': (c) => `${c.actor} ændrede ${centralTemplate(c)}${version(c.details)}`,
  'central_template.retarget': (c) => `${c.actor} ændrede, hvem der har ${centralTemplate(c)} til rådighed${version(c.details)}`,
  'central_template.archive': (c) => `${c.actor} arkiverede ${centralTemplate(c)}${version(c.details)}`,
  'central_template.restore': (c) => `${c.actor} genoprettede ${centralTemplate(c)}${version(c.details)}`,

  'minutes.generate': (c) => {
    if (c.failed) return `${c.actor} kunne ikke generere et referat`;
    const central = c.details.templateSource === 'central';
    return `${c.actor} genererede et referat${central ? ` med en central skabelon${version({ version: c.details.templateVersion })}` : ''}`;
  },
  'export.download': (c) => {
    const format = typeof c.details.format === 'string' ? ` (${c.details.format})` : '';
    return c.failed ? `${c.actor} kunne ikke hente en eksport${format}` : `${c.actor} hentede en eksport${format}`;
  },

  'bot.session_start': (c) => `${c.actor} startede mødebotten`,
  'bot.session_stop': (c) => `${c.actor} stoppede mødebotten`,
  'bot.session_abort': (c) => `${c.actor} afbrød mødebotten`,
  'bot.ended': (c) => {
    const secs = num(c.details.durationSeconds);
    const mins = secs === null ? null : Math.max(1, Math.round(secs / 60));
    return `Mødebotten forlod mødet${mins === null ? '' : ` efter ${mins} min.`}`;
  },
  'bot.error': () => 'Mødebotten fejlede',

  'meeting.create': (c) => {
    const origin = ORIGIN_TEXT[String(c.details.origin)];
    return `${c.actor} oprettede et møde${origin ? ` (${origin})` : ''}`;
  },
  'meeting.delete': (c) => `${c.actor} slettede et møde`,
  'meeting.redact': (c) => `${c.actor} slørede et møde`,
  'meeting.audio_delete': (c) => `${c.actor} slettede lyden fra et møde`,

  'access.role_assign': (c) =>
    `${c.actor} tildelte en bruger rollen ${roleName(c.details.roleKey)}${c.details.bootstrap === true ? ' (opstartsadministrator)' : ''}`,
  'access.role_revoke': (c) => `${c.actor} fjernede rollen ${roleName(c.details.roleKey)} fra en bruger`,
  'access.org_unit_create': (c) => `${c.actor} oprettede en organisationsenhed`,
  'access.org_unit_update': (c) => {
    const what = [c.details.nameChanged === true && 'navn', c.details.parentChanged === true && 'placering'].filter(Boolean);
    return `${c.actor} ændrede en organisationsenhed${what.length > 0 ? ` (${what.join(' og ')})` : ''}`;
  },
  'access.org_unit_delete': (c) => `${c.actor} slettede en organisationsenhed`,
  'access.member_add': (c) => `${c.actor} tilføjede en bruger til en organisationsenhed`,
  'access.member_remove': (c) => `${c.actor} fjernede en bruger fra en organisationsenhed`,
  'access.user_create': (c) => `${c.actor} oprettede en bruger i organisationen`,
  // The actor of a link is the user who logged in and was matched.
  'access.user_link': (c) =>
    c.details.automatic === false
      ? `${c.actor} blev koblet til en brugerprofil i organisationen`
      : `${c.actor} blev automatisk koblet til sin brugerprofil i organisationen`,

  'audit.export': (c) => {
    const rows = num(c.details.rowCount);
    return `${c.actor} eksporterede loggen${rows === null ? '' : ` (${plural(rows, 'række', 'rækker')}${c.details.truncated === true ? ', afkortet' : ''})`}`;
  },
  'audit.prune': (c) => {
    const n = num(c.details.deletedCount);
    const days = num(c.details.olderThanDays);
    return `Systemet slettede ${n === null ? 'gamle' : plural(n, 'logpost', 'logposter')}${days === null ? '' : ` ældre end ${plural(days, 'dag', 'dage')}`}`;
  },
};

function actorText(e: SummarisableEvent): string {
  if (e.actorName && e.actorName.trim()) return e.actorName;
  if (e.actorUserId) return 'Ukendt bruger';
  return e.source === 'system' ? 'Systemet' : 'Ukendt bruger';
}

/** One Danish sentence describing the event. Unknown (legacy) types fall back to their label. */
export function summariseEvent(e: SummarisableEvent): string {
  const actor = actorText(e);
  if (!isEventType(e.eventType)) return `${actor}: ${eventTypeLabel(e.eventType)}`;
  const isCentral = e.eventType.startsWith('central_template.');
  return SENTENCES[e.eventType]({
    actor,
    failed: e.outcome !== 'success',
    details: e.details ?? {},
    templateName: isCentral && e.templateName ? e.templateName : null,
  });
}

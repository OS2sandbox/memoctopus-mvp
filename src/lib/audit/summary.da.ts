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
import { capabilityLabels } from '@/lib/authz/labels.da';
import type { Capability } from '@/lib/authz/types';
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

function centralTemplate(c: Ctx): string {
  return c.templateName ? `den centrale skabelon »${c.templateName}«` : 'en central skabelon';
}

const METHOD_TEXT: Record<string, string> = {
  password: ' med adgangskode',
  microsoft: ' med Microsoft',
  oidc: ' via single sign-on',
  saml: ' via single sign-on (SAML)',
};

const LOGIN_FAILED_REASON: Record<string, string> = {
  invalid_credentials: 'forkerte loginoplysninger',
  oauth_error: 'fejl hos login-udbyderen',
  account_not_linked: 'kontoen er ikke koblet til en bruger',
  rate_limited: 'for mange forsøg',
};

const ORIGIN_TEXT: Record<string, string> = { live: 'live optagelse', upload: 'upload', bot: 'mødebot' };

// Deletes the app made on its own say so; a user delete or a missing trigger reads as the person's own.
const AUTO_TRIGGER_TEXT: Record<string, string> = {
  auto_generate: ' (automatisk efter referatet blev genereret)',
  auto_leave: ' (automatisk, da siden blev forladt)',
  auto_pagehide: ' (automatisk, da fanen blev lukket)',
  auto_empty: ' (automatisk, fordi optagelsen var tom)',
};
const autoText = (d: Record<string, unknown>) => AUTO_TRIGGER_TEXT[String(d.trigger)] ?? '';

// What was sent and what for. `live` is logged at most once per person and meeting per 5
// minutes (the audio of a live recording goes up utterance by utterance), `diarize` goes to
// speaker detection rather than transcription.
const AUDIO_CHANNEL_TEXT: Record<string, { what: string; purpose: string }> = {
  batch: { what: 'en optagelse', purpose: 'transskribering' },
  upload: { what: 'en lydfil', purpose: 'transskribering' },
  bot: { what: 'en mødebot-optagelse', purpose: 'transskribering' },
  live: { what: 'lyd fra en live optagelse', purpose: 'transskribering' },
  diarize: { what: 'en optagelse', purpose: 'taleropdeling' },
};

// `activate` is an in-app version switch: the nearest thing to a restore (nothing is copied or recreated).
const VERSION_ACTION_TEXT: Record<string, (v: string, n: number | null) => string> = {
  view: (v) => `åbnede en tidligere version af referatet${v}`,
  snapshot: (v) => `gemte en ny version af referatet${v}`,
  generate: (v) => `genererede en ny version af referatet${v}`,
  activate: (_v, n) => `satte ${n === null ? 'en version' : `version ${n}`} som den aktive version af referatet`,
};

const DROP_REASON_TEXT: Record<string, string> = {
  daily_cap: 'dagsgrænsen for en bruger var nået',
  rate_limit: 'for mange hændelser på kort tid',
  actor_ceiling: 'grænsen for serverhændelser pr. bruger var nået',
  throttle: 'gentagne visninger inden for et minut',
  client_outbox: 'browserens kø mistede hændelser, før de blev sendt',
};

const SENTENCES: Record<EventType, (c: Ctx) => string> = {
  'auth.login': (c) => `${c.actor} loggede ind${METHOD_TEXT[String(c.details.method)] ?? ''}`,
  'auth.logout': (c) => `${c.actor} loggede ud`,
  // The attempt has no (trusted) user, so there is no actor in the sentence.
  'auth.login_failed': (c) => {
    const dropped = num(c.details.droppedCount);
    if (dropped !== null) return `${plural(dropped, 'yderligere mislykket login-forsøg', 'yderligere mislykkede login-forsøg')} fra samme adresse blev ikke registreret enkeltvis`;
    const reason = LOGIN_FAILED_REASON[String(c.details.reason)];
    return `Mislykket login-forsøg${reason ? ` (${reason})` : ''}`;
  },
  'authz.denied': (c) => {
    const dropped = num(c.details.droppedCount);
    if (dropped !== null) return `${plural(dropped, 'yderligere afvisning', 'yderligere afvisninger')} af adgang for ${c.actor} blev ikke registreret enkeltvis`;
    const required = String(c.details.required);
    const label = has(capabilityLabels, required) ? capabilityLabels[required as Capability] : null;
    return `${c.actor} fik adgang nægtet${label ? ` til »${label}«` : ''}`;
  },

  'template.create': (c) => `${c.actor} oprettede en skabelon`,
  'template.update': (c) => `${c.actor} ændrede en skabelon${c.details.hasChangeNote === true ? ' og skrev en ændringsbeskrivelse' : ''}`,
  'template.delete': (c) => `${c.actor} slettede en skabelon`,
  'template.share': (c) => `${c.actor} delte en skabelon via link`,
  'template.import': (c) => `${c.actor} importerede en skabelon fra et link`,

  'central_template.create': (c) => `${c.actor} oprettede ${centralTemplate(c)}`,
  'central_template.update': (c) => `${c.actor} ændrede ${centralTemplate(c)}${version(c.details)}`,
  'central_template.retarget': (c) => `${c.actor} ændrede, hvem der har ${centralTemplate(c)} til rådighed${version(c.details)}`,
  'central_template.archive': (c) => `${c.actor} arkiverede ${centralTemplate(c)}, så den er fjernet for alle${version(c.details)}`,
  'central_template.restore': (c) => `${c.actor} genoprettede ${centralTemplate(c)}${version(c.details)}`,

  'audio.upload': (c) => {
    const { what, purpose } = AUDIO_CHANNEL_TEXT[String(c.details.channel)] ?? { what: 'lyd', purpose: 'transskribering' };
    return c.failed ? `${c.actor} kunne ikke uploade ${what} til ${purpose}` : `${c.actor} uploadede ${what} til ${purpose}`;
  },
  'minutes.generate': (c) => {
    if (c.failed) return `${c.actor} kunne ikke generere et referat`;
    const central = c.details.templateSource === 'central';
    const instruction = c.details.userInstruction === true ? ' og en ekstra instruktion' : '';
    return `${c.actor} genererede et referat${central ? ` med en central skabelon${version({ version: c.details.templateVersion })}` : ''}${instruction}`;
  },
  'export.download': (c) => {
    const format = typeof c.details.format === 'string' ? ` (${c.details.format})` : '';
    return c.failed ? `${c.actor} kunne ikke hente en eksport${format}` : `${c.actor} hentede en eksport${format}`;
  },

  'bot.session_start': (c) => `${c.actor} startede mødebotten`,
  'bot.session_pause': (c) => `${c.actor} satte mødebotten på pause`,
  'bot.session_resume': (c) => `${c.actor} genoptog mødebotten`,
  'bot.session_stop': (c) => `${c.actor} stoppede mødebotten`,
  'bot.session_abort': (c) => `${c.actor} afbrød mødebotten`,
  'bot.audio_delete': (c) => {
    const transcript = c.details.object === 'transcript';
    const what = transcript ? 'en mødebot-transskription' : 'en mødebot-optagelse';
    return c.details.trigger === 'ttl'
      ? `Systemet slettede ${what} på serveren, som ingen havde hentet`
      : `Systemet slettede ${transcript ? 'mødebottens transskription' : 'mødebottens optagelse'} på serveren, efter at den var hentet`;
  },
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
  'meeting.delete': (c) => `${c.actor} slettede et møde med transskription, referatversioner og lyd${autoText(c.details)}`,
  'meeting.redact': (c) => `${c.actor} slørede et møde`,
  'meeting.audio_delete': (c) => `${c.actor} slettede lyden fra et møde${autoText(c.details)}`,
  'meeting.minutes_view': (c) => `${c.actor} åbnede et referat`,
  'meeting.transcript_view': (c) => `${c.actor} åbnede en transskription`,
  'meeting.audio_play': (c) => `${c.actor} afspillede lyden fra et møde`,
  'meeting.recording_start': (c) => `${c.actor} startede en optagelse`,
  'meeting.recording_pause': (c) => `${c.actor} satte en optagelse på pause`,
  'meeting.recording_resume': (c) => `${c.actor} genoptog en optagelse`,
  'meeting.recording_stop': (c) => `${c.actor} stoppede en optagelse`,
  'meeting.minutes_save': (c) => `${c.actor} redigerede et referat`,
  'meeting.transcript_edit': (c) => `${c.actor} redigerede en transskription`,
  'meeting.metadata_edit': (c) =>
    `${c.actor} ændrede ${c.details.field === 'recorded_at' ? 'datoen for' : 'titlen på'} et møde`,
  'meeting.minutes_version': (c) => {
    const text = VERSION_ACTION_TEXT[String(c.details.action)];
    const v = version({ version: c.details.versionNumber });
    return `${c.actor} ${text ? text(v, num(c.details.versionNumber)) : `ændrede en version af et referat${v}`}`;
  },
  'meeting.minutes_version_prune': (c) => {
    const n = num(c.details.prunedCount);
    return `Appen fjernede de ældste referatversioner fra et møde, fordi grænsen for antal versioner var nået${n === null ? '' : ` (${plural(n, 'version', 'versioner')})`}`;
  },
  'meeting.participants_edit': (c) => {
    const n = num(c.details.participantCount);
    return `${c.actor} ændrede deltagerne på et møde${n === null ? '' : ` (${plural(n, 'deltager', 'deltagere')})`}`;
  },
  'meeting.speakers_edit': (c) => `${c.actor} ændrede talerne på et møde`,

  'system.config_changed': (c) =>
    c.details.changed === true ? 'Systemets konfiguration er ændret siden sidste start' : 'Systemets konfiguration blev registreret ved opstart',

  'audit.export': (c) => {
    const rows = num(c.details.rowCount);
    return `${c.actor} eksporterede loggen${rows === null ? '' : ` (${plural(rows, 'række', 'rækker')}${c.details.truncated === true ? ', afkortet' : ''})`}`;
  },
  'audit.events_dropped': (c) => {
    const n = num(c.details.count);
    const many = n === null ? 'Hændelser' : plural(n, 'hændelse', 'hændelser');
    const why = DROP_REASON_TEXT[String(c.details.reason)];
    return `${many} blev ikke registreret${why ? ` (${why})` : ''}`;
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

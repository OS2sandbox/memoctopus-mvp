// Danish wording for the audit viewer and the CSV header. Exhaustive Records:
// adding an event type, source or outcome without a label is a compile error.
import type { EventType } from './events';
import type { EventOutcome, EventSource } from './events/types';

export const eventTypeLabels: Record<EventType, string> = {
  // Adgang
  'authz.denied': 'Adgang nægtet',
  // Login
  'auth.login': 'Login',
  'auth.logout': 'Logout',
  'auth.login_failed': 'Mislykket login',
  // Skabeloner
  'template.create': 'Skabelon oprettet',
  'template.update': 'Skabelon ændret',
  'template.delete': 'Skabelon slettet',
  'template.share': 'Skabelon delt',
  'template.import': 'Skabelon importeret',
  'central_template.create': 'Central skabelon oprettet',
  'central_template.update': 'Central skabelon ændret',
  'central_template.retarget': 'Tilgængelighed af central skabelon ændret',
  'central_template.archive': 'Central skabelon arkiveret',
  'central_template.restore': 'Central skabelon genoprettet',
  // Lyd, AI og eksport
  'audio.upload': 'Lyd uploadet til transskribering',
  'minutes.generate': 'Referat genereret',
  'export.download': 'Eksport hentet',
  // Mødebot
  'bot.session_start': 'Mødebot startet',
  'bot.session_pause': 'Mødebot sat på pause',
  'bot.session_resume': 'Mødebot genoptaget',
  'bot.session_stop': 'Mødebot stoppet',
  'bot.session_abort': 'Mødebot afbrudt',
  'bot.audio_delete': 'Mødebottens lydfil slettet på serveren',
  'bot.ended': 'Mødebot er forladt mødet',
  'bot.error': 'Fejl i mødebot',
  // Møder (rapporteret af klienten)
  'meeting.create': 'Møde oprettet',
  'meeting.delete': 'Møde slettet',
  'meeting.redact': 'Møde sløret',
  'meeting.audio_delete': 'Lyd slettet',
  'meeting.minutes_view': 'Referat vist',
  'meeting.transcript_view': 'Transskription vist',
  'meeting.audio_play': 'Lyd afspillet',
  'meeting.recording_start': 'Optagelse startet',
  'meeting.recording_pause': 'Optagelse sat på pause',
  'meeting.recording_resume': 'Optagelse genoptaget',
  'meeting.recording_stop': 'Optagelse stoppet',
  'meeting.minutes_save': 'Referat redigeret',
  'meeting.minutes_version': 'Referatversion',
  'meeting.minutes_version_prune': 'Gamle referatversioner fjernet',
  'meeting.participants_edit': 'Deltagere ændret',
  'meeting.speakers_edit': 'Talere ændret',
  // Systemet
  'system.config_changed': 'Systemkonfiguration ændret',
  // Loggen selv
  'audit.export': 'Log eksporteret',
  'audit.prune': 'Gamle logposter slettet',
};

export const outcomeLabels: Record<EventOutcome, string> = {
  success: 'Gennemført',
  denied: 'Nægtet',
  error: 'Fejlet',
};

export const sourceLabels: Record<EventSource, string> = {
  server: 'Serveren',
  client: 'Selvrapporteret af klienten',
  system: 'Systemet',
};

/** Short form for a table badge; a client event is only ever the client's own claim. */
export const sourceBadgeLabels: Record<EventSource, string> = {
  server: 'server',
  client: 'selvrapporteret',
  system: 'system',
};

/** Label for a stored value that may predate the current catalogue (rows outlive code changes). */
export function eventTypeLabel(type: string): string {
  return Object.prototype.hasOwnProperty.call(eventTypeLabels, type) ? eventTypeLabels[type as EventType] : type;
}

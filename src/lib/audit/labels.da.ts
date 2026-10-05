// Danish wording for the audit viewer and the CSV header. Exhaustive Records:
// adding an event type, source or outcome without a label is a compile error.
import type { EventType } from './events';
import type { EventOutcome, EventSource } from './events/types';

export const eventTypeLabels: Record<EventType, string> = {
  // Adgang og roller
  'access.role_assign': 'Rolle tildelt',
  'access.role_revoke': 'Rolle fjernet',
  'access.org_unit_create': 'Organisationsenhed oprettet',
  'access.org_unit_update': 'Organisationsenhed ændret',
  'access.org_unit_delete': 'Organisationsenhed slettet',
  'access.member_add': 'Medlem tilføjet til enhed',
  'access.member_remove': 'Medlem fjernet fra enhed',
  'access.user_create': 'Bruger oprettet',
  'access.user_update': 'Bruger ændret',
  'access.user_delete': 'Bruger slettet',
  'access.user_link': 'Bruger koblet til organisationen',
  'authz.denied': 'Adgang nægtet',
  // Login
  'auth.login': 'Login',
  'auth.logout': 'Logout',
  'auth.login_failed': 'Mislykket login',
  // Skabeloner
  'template.create': 'Skabelon oprettet',
  'template.update': 'Skabelon ændret',
  'template.delete': 'Skabelon slettet',
  'template.set_default': 'Standardskabelon valgt',
  'template.share': 'Skabelon delt',
  'template.import': 'Skabelon importeret',
  // AI og eksport
  'minutes.generate': 'Referat genereret',
  'transcription.request': 'Transskription anmodet',
  'diarization.request': 'Talergenkendelse anmodet',
  'chapters.request': 'Kapitelinddeling anmodet',
  'clarifications.request': 'Afklarende spørgsmål anmodet',
  'export.download': 'Eksport hentet',
  // Mødebot
  'bot.session_start': 'Mødebot startet',
  'bot.session_pause': 'Mødebot sat på pause',
  'bot.session_resume': 'Mødebot genoptaget',
  'bot.session_stop': 'Mødebot stoppet',
  'bot.session_abort': 'Mødebot afbrudt',
  'bot.audio_collect': 'Lyd hentet fra mødebot',
  'bot.transcript_collect': 'Transskription hentet fra mødebot',
  'bot.joined': 'Mødebot er med i mødet',
  'bot.ended': 'Mødebot er forladt mødet',
  'bot.error': 'Fejl i mødebot',
  // Møder (rapporteret af klienten)
  'meeting.create': 'Møde oprettet',
  'meeting.status_change': 'Mødestatus ændret',
  'meeting.rename': 'Møde omdøbt',
  'meeting.participants_edit': 'Deltagere ændret',
  'meeting.delete': 'Møde slettet',
  'meeting.redact': 'Møde sløret',
  'meeting.audio_delete': 'Lyd slettet',
  'meeting.transcript_edit': 'Transskription redigeret',
  'meeting.minutes_save': 'Referat gemt',
  'meeting.minutes_version': 'Referatversion oprettet',
  // Synkronisering
  'directory.sync': 'Organisation synkroniseret fra Rollekatalog',
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

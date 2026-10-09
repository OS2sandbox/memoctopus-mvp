// The viewer groups the closed event catalogue into six human categories. The
// Record is exhaustive over EventType: a new event type without a category is a
// compile error, and the categories together cover the catalogue exactly once.
// Client-safe: only a type import and plain data (EVENT_TYPES is a value import
// from the catalogue, which the viewer already pulls in through labels.da).
import { EVENT_TYPES, type EventType } from './events';

export const CATEGORY_KEYS = ['login', 'templates', 'meetings', 'views', 'edits', 'log'] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export const categoryLabels: Record<CategoryKey, string> = {
  login: 'Login og adgang',
  templates: 'Skabeloner',
  meetings: 'Møder og optagelser',
  views: 'Visning og afspilning',
  edits: 'Redigering af møder',
  log: 'Loggen og systemet',
};

export const CATEGORY_OF: Record<EventType, CategoryKey> = {
  'auth.login': 'login',
  'auth.logout': 'login',
  'auth.login_failed': 'login',
  'authz.denied': 'login',
  'template.create': 'templates',
  'template.update': 'templates',
  'template.delete': 'templates',
  'template.share': 'templates',
  'template.import': 'templates',
  'central_template.create': 'templates',
  'central_template.update': 'templates',
  'central_template.retarget': 'templates',
  'central_template.archive': 'templates',
  'central_template.restore': 'templates',
  'minutes.generate': 'meetings',
  'export.download': 'meetings',
  'audio.upload': 'meetings',
  'bot.session_start': 'meetings',
  'bot.session_pause': 'meetings',
  'bot.session_resume': 'meetings',
  'bot.session_stop': 'meetings',
  'bot.session_abort': 'meetings',
  'bot.audio_delete': 'meetings',
  'bot.ended': 'meetings',
  'bot.error': 'meetings',
  'meeting.create': 'meetings',
  'meeting.delete': 'meetings',
  'meeting.redact': 'meetings',
  'meeting.audio_delete': 'meetings',
  'meeting.recording_start': 'meetings',
  'meeting.recording_pause': 'meetings',
  'meeting.recording_resume': 'meetings',
  'meeting.recording_stop': 'meetings',
  'meeting.minutes_view': 'views',
  'meeting.transcript_view': 'views',
  'meeting.audio_play': 'views',
  'meeting.minutes_save': 'edits',
  'meeting.transcript_edit': 'edits',
  'meeting.metadata_edit': 'edits',
  'meeting.minutes_version': 'edits',
  'meeting.minutes_version_prune': 'edits',
  'meeting.participants_edit': 'edits',
  'meeting.speakers_edit': 'edits',
  'system.config_changed': 'log',
  'audit.export': 'log',
  'audit.events_dropped': 'log',
  'audit.prune': 'log',
};

export const CATEGORIES: ReadonlyArray<{ key: CategoryKey; label: string }> = CATEGORY_KEYS.map((key) => ({
  key,
  label: categoryLabels[key],
}));

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === 'string' && (CATEGORY_KEYS as readonly string[]).includes(value);
}

/** Every event type of a category, in catalogue order. */
export function eventTypesOfCategory(key: CategoryKey): EventType[] {
  return EVENT_TYPES.filter((t) => CATEGORY_OF[t] === key);
}

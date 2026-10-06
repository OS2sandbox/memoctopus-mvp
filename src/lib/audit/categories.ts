// The viewer groups the closed event catalogue into five human categories. The
// Record is exhaustive over EventType: a new event type without a category is a
// compile error, and the categories together cover the catalogue exactly once.
// Client-safe: only a type import and plain data (EVENT_TYPES is a value import
// from the catalogue, which the viewer already pulls in through labels.da).
import { EVENT_TYPES, type EventType } from './events';

export const CATEGORY_KEYS = ['login', 'templates', 'meetings', 'access', 'log'] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export const categoryLabels: Record<CategoryKey, string> = {
  login: 'Login og adgang',
  templates: 'Skabeloner',
  meetings: 'Møder og optagelser',
  access: 'Brugere og roller',
  log: 'Loggen',
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
  'bot.session_start': 'meetings',
  'bot.session_stop': 'meetings',
  'bot.session_abort': 'meetings',
  'bot.ended': 'meetings',
  'bot.error': 'meetings',
  'meeting.create': 'meetings',
  'meeting.delete': 'meetings',
  'meeting.redact': 'meetings',
  'meeting.audio_delete': 'meetings',
  'access.role_assign': 'access',
  'access.role_revoke': 'access',
  'access.org_unit_create': 'access',
  'access.org_unit_update': 'access',
  'access.org_unit_delete': 'access',
  'access.member_add': 'access',
  'access.member_remove': 'access',
  'access.user_create': 'access',
  'access.user_link': 'access',
  'audit.export': 'log',
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

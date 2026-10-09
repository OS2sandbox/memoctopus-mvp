import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from './events';
import { CATEGORIES, CATEGORY_KEYS, CATEGORY_OF, categoryLabels, eventTypesOfCategory, isCategoryKey } from './categories';

describe('audit categories', () => {
  it('puts every catalogue type into exactly one category', () => {
    const all = CATEGORY_KEYS.flatMap((k) => eventTypesOfCategory(k));
    expect([...all].sort()).toEqual([...EVENT_TYPES].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('has no entries for types outside the catalogue', () => {
    expect(Object.keys(CATEGORY_OF).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('groups by prefix as documented', () => {
    expect([...eventTypesOfCategory('login')].sort()).toEqual(['auth.login', 'auth.login_failed', 'auth.logout', 'authz.denied']);
    expect([...eventTypesOfCategory('log')].sort()).toEqual(['audit.events_dropped', 'audit.export', 'audit.prune', 'system.config_changed']);
    expect(eventTypesOfCategory('templates').every((t) => /^(central_)?template\./.test(t))).toBe(true);
    expect([...eventTypesOfCategory('views')].sort()).toEqual(['meeting.audio_play', 'meeting.minutes_view', 'meeting.transcript_view']);
    expect(eventTypesOfCategory('edits').every((t) => t.startsWith('meeting.'))).toBe(true);
    expect(eventTypesOfCategory('log')).toContain('system.config_changed');
    expect(CATEGORY_KEYS).not.toContain('access');
    const meetings = eventTypesOfCategory('meetings');
    expect(meetings).toEqual(expect.arrayContaining(['minutes.generate', 'export.download', 'meeting.delete', 'bot.error']));
  });

  it('has Danish labels for all categories, in display order', () => {
    expect(CATEGORIES.map((c) => c.label)).toEqual([
      'Login og adgang',
      'Skabeloner',
      'Møder og optagelser',
      'Visning og afspilning',
      'Redigering af møder',
      'Loggen og systemet',
    ]);
    expect(Object.keys(categoryLabels)).toHaveLength(CATEGORY_KEYS.length);
  });

  it('isCategoryKey narrows safely', () => {
    expect(isCategoryKey('login')).toBe(true);
    expect(isCategoryKey('constructor')).toBe(false);
    expect(isCategoryKey(undefined)).toBe(false);
  });
});

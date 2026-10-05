import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from './events';
import { EVENT_OUTCOMES, EVENT_SOURCES } from './events/types';
import { eventTypeLabel, eventTypeLabels, outcomeLabels, sourceBadgeLabels, sourceLabels } from './labels.da';

const nonEmpty = (s: unknown) => typeof s === 'string' && s.trim().length > 0;

describe('audit labels', () => {
  it('cover exactly the catalogue, with non-empty text', () => {
    expect(Object.keys(eventTypeLabels).sort()).toEqual([...EVENT_TYPES].sort());
    for (const t of EVENT_TYPES) expect(nonEmpty(eventTypeLabels[t]), t).toBe(true);
  });

  it('give every event type its own label (a filter select must be unambiguous)', () => {
    expect(new Set(Object.values(eventTypeLabels)).size).toBe(EVENT_TYPES.length);
  });

  it('cover every outcome and source', () => {
    for (const o of EVENT_OUTCOMES) expect(nonEmpty(outcomeLabels[o]), o).toBe(true);
    for (const s of EVENT_SOURCES) {
      expect(nonEmpty(sourceLabels[s]), s).toBe(true);
      expect(nonEmpty(sourceBadgeLabels[s]), s).toBe(true);
    }
  });

  it('labels client events as reported by the client, not as fact', () => {
    expect(sourceLabels.client).toBe('Selvrapporteret af klienten');
    expect(sourceBadgeLabels.client).toBe('selvrapporteret');
  });

  it('falls back to the raw code for a type this build does not know', () => {
    expect(eventTypeLabel('meeting.delete')).toBe(eventTypeLabels['meeting.delete']);
    expect(eventTypeLabel('legacy.thing')).toBe('legacy.thing');
    expect(eventTypeLabel('toString')).toBe('toString');
  });
});

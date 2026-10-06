import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from './events';
import { eventTypeLabel, eventTypeLabels, sourceBadgeLabels, sourceLabels } from './labels.da';

describe('audit labels', () => {
  it('give every event type its own label (a filter select must be unambiguous)', () => {
    expect(new Set(Object.values(eventTypeLabels)).size).toBe(EVENT_TYPES.length);
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

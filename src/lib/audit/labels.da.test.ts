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

  it('shows a type this build does not know as "Ukendt hændelsestype" with its code', () => {
    expect(eventTypeLabel('meeting.delete')).toBe(eventTypeLabels['meeting.delete']);
    expect(eventTypeLabel('legacy.thing')).toBe('Ukendt hændelsestype (legacy.thing)');
    expect(eventTypeLabel('toString')).toBe('Ukendt hændelsestype (toString)');
  });
});

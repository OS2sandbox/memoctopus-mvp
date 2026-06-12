import { describe, it, expect } from 'vitest';
import { speakerLabel, DEFAULT_SPEAKER_LABEL, isDefaultSpeakerLabel, nextAvailableSpeakerLabel } from './speaker-labels';

// These assertions pin the Danish label convention shared by transcription,
// vad-batch, and merge-speakers. If the wording ever changes intentionally,
// update it here once — a silent change would desync the three call sites.
describe('speaker labels', () => {
  it('formats the Nth speaker 1-indexed as "Taler N"', () => {
    expect(speakerLabel(1)).toBe('Taler 1');
    expect(speakerLabel(2)).toBe('Taler 2');
    expect(speakerLabel(10)).toBe('Taler 10');
  });

  it('DEFAULT_SPEAKER_LABEL is the first speaker', () => {
    expect(DEFAULT_SPEAKER_LABEL).toBe('Taler 1');
    expect(DEFAULT_SPEAKER_LABEL).toBe(speakerLabel(1));
  });

  it('treats generic "Taler N" labels as unassigned', () => {
    expect(isDefaultSpeakerLabel('Taler 1')).toBe(true);
    expect(isDefaultSpeakerLabel('Taler 12')).toBe(true);
    expect(isDefaultSpeakerLabel('  Taler 3  ')).toBe(true);
  });

  it('treats a real name as assigned', () => {
    expect(isDefaultSpeakerLabel('Mette')).toBe(false);
    expect(isDefaultSpeakerLabel('Taler')).toBe(false);
    expect(isDefaultSpeakerLabel('Taler Jensen')).toBe(false);
    expect(isDefaultSpeakerLabel('')).toBe(false);
  });

  it('finds the lowest free "Taler N", filling gaps', () => {
    expect(nextAvailableSpeakerLabel(new Set())).toBe('Taler 1');
    expect(nextAvailableSpeakerLabel(new Set(['Taler 1', 'Taler 2']))).toBe('Taler 3');
    expect(nextAvailableSpeakerLabel(new Set(['Taler 1', 'Taler 3']))).toBe('Taler 2');
    expect(nextAvailableSpeakerLabel(new Set(['Mette', 'Taler 1']))).toBe('Taler 2');
  });
});

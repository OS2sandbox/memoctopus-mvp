import { describe, it, expect } from 'vitest';
import { isRealParticipant, realParticipants } from '../../src/lib/participants';

describe('isRealParticipant', () => {
  it('accepts a real human name', () => {
    expect(isRealParticipant('Nikolaj Meineche', 'OS2taletiltekst')).toBe(true);
  });

  it('rejects the bot itself (case-insensitive)', () => {
    expect(isRealParticipant('OS2taletiltekst', 'OS2taletiltekst')).toBe(false);
    expect(isRealParticipant('os2taletiltekst', 'OS2taletiltekst')).toBe(false);
  });

  it('rejects the "Microsoft Teams meeting" phantom (the auto-leave bug)', () => {
    expect(isRealParticipant('Microsoft Teams meeting', 'OS2taletiltekst')).toBe(false);
    expect(isRealParticipant('  microsoft teams meeting  ', 'OS2taletiltekst')).toBe(false);
  });

  it('rejects other system phantoms and the audio sentinel', () => {
    expect(isRealParticipant('Microsoft Teams', 'OS2taletiltekst')).toBe(false);
    expect(isRealParticipant('Teams meeting', 'OS2taletiltekst')).toBe(false);
    expect(isRealParticipant('__audio_detected__', 'OS2taletiltekst')).toBe(false);
  });

  it('rejects blank names', () => {
    expect(isRealParticipant('', 'OS2taletiltekst')).toBe(false);
    expect(isRealParticipant('   ', 'OS2taletiltekst')).toBe(false);
  });
});

describe('realParticipants', () => {
  it('filters a roster down to real humans (the exact failing case)', () => {
    const roster = ['OS2taletiltekst', 'Nikolaj Meineche', 'Microsoft Teams meeting'];
    expect(realParticipants(roster, 'OS2taletiltekst')).toEqual(['Nikolaj Meineche']);
  });

  it('returns empty when only the bot and phantom remain (→ bot is alone)', () => {
    expect(realParticipants(['OS2taletiltekst', 'Microsoft Teams meeting'], 'OS2taletiltekst')).toEqual([]);
  });
});

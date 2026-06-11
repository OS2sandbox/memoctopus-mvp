import { describe, it, expect } from 'vitest';
import { isRealParticipant, realParticipants } from '../../src/lib/participants';

describe('isRealParticipant', () => {
  it('accepts a real human name', () => {
    expect(isRealParticipant('Nikolaj Meineche', 'Memoctopus')).toBe(true);
  });

  it('rejects the bot itself (case-insensitive)', () => {
    expect(isRealParticipant('Memoctopus', 'Memoctopus')).toBe(false);
    expect(isRealParticipant('memoctopus', 'Memoctopus')).toBe(false);
  });

  it('rejects the "Microsoft Teams meeting" phantom (the auto-leave bug)', () => {
    expect(isRealParticipant('Microsoft Teams meeting', 'Memoctopus')).toBe(false);
    expect(isRealParticipant('  microsoft teams meeting  ', 'Memoctopus')).toBe(false);
  });

  it('rejects other system phantoms and the audio sentinel', () => {
    expect(isRealParticipant('Microsoft Teams', 'Memoctopus')).toBe(false);
    expect(isRealParticipant('Teams meeting', 'Memoctopus')).toBe(false);
    expect(isRealParticipant('__audio_detected__', 'Memoctopus')).toBe(false);
  });

  it('rejects blank names', () => {
    expect(isRealParticipant('', 'Memoctopus')).toBe(false);
    expect(isRealParticipant('   ', 'Memoctopus')).toBe(false);
  });
});

describe('realParticipants', () => {
  it('filters a roster down to real humans (the exact failing case)', () => {
    const roster = ['Memoctopus', 'Nikolaj Meineche', 'Microsoft Teams meeting'];
    expect(realParticipants(roster, 'Memoctopus')).toEqual(['Nikolaj Meineche']);
  });

  it('returns empty when only the bot and phantom remain (→ bot is alone)', () => {
    expect(realParticipants(['Memoctopus', 'Microsoft Teams meeting'], 'Memoctopus')).toEqual([]);
  });
});

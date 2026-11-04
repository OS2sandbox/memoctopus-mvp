import { describe, it, expect, vi } from 'vitest';
import { ONBOARDING_STEPS, getStep, findStep } from './steps';

const PLACEMENTS = ['top', 'bottom', 'left', 'right'];
const SEVERITIES = ['high', 'medium', 'low'];
const SCOPES = ['global', 'per-meeting'];
const ENGINES = ['popover', 'tooltip'];

describe('ONBOARDING_STEPS registry', () => {
  it('keys every step by its own id', () => {
    for (const [key, step] of Object.entries(ONBOARDING_STEPS)) {
      expect(step.id).toBe(key);
    }
  });

  it('gives every step well-formed metadata', () => {
    for (const step of Object.values(ONBOARDING_STEPS)) {
      expect(PLACEMENTS).toContain(step.placement);
      expect(SEVERITIES).toContain(step.severity);
      expect(SCOPES).toContain(step.scope);
      expect(ENGINES).toContain(step.engine);
      expect(step.copy.trim().length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate ids', () => {
    const ids = Object.values(ONBOARDING_STEPS).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('getStep', () => {
  it('returns the step for a known id', () => {
    expect(getStep('dashboard.record-button')).toBe(ONBOARDING_STEPS['dashboard.record-button']);
  });

  it('throws for an unknown id', () => {
    expect(() => getStep('not.a.real.step')).toThrow(/not\.a\.real\.step/);
  });

  it('throws instead of resolving an inherited object key', () => {
    expect(() => getStep('constructor')).toThrow();
  });
});

describe('findStep', () => {
  it('returns the step for a known id without logging', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(findStep('dashboard.record-button')).toBe(ONBOARDING_STEPS['dashboard.record-button']);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns undefined and logs for an unknown id, instead of throwing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(findStep('not.a.real.step')).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('not.a.real.step'));
    spy.mockRestore();
  });

  it('returns undefined instead of resolving an inherited object key', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(findStep('constructor')).toBeUndefined();
    spy.mockRestore();
  });
});

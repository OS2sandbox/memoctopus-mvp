import { describe, it, expect } from 'vitest';
import { roleScopeRule } from './role-rules';

describe('roleScopeRule', () => {
  it('pins the rule per role', () => {
    expect(roleScopeRule('tt-bruger')).toBe('forbidden');
    expect(roleScopeRule('tt-skabelonansvarlig')).toBe('optional'); // global = the superuser who manages every shared prompt
    expect(roleScopeRule('tt-logleser')).toBe('optional');
    expect(roleScopeRule('tt-administrator')).toBe('forbidden');
  });
});

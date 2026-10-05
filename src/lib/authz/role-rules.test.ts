import { describe, it, expect } from 'vitest';
import { ROLE_KEYS } from './types';
import { roleScopeRule } from './role-rules';

describe('roleScopeRule', () => {
  it('pins the rule per role', () => {
    expect(roleScopeRule('tt-bruger')).toBe('forbidden');
    expect(roleScopeRule('tt-skabelonansvarlig')).toBe('required');
    expect(roleScopeRule('tt-logleser')).toBe('optional');
    expect(roleScopeRule('tt-administrator')).toBe('forbidden');
  });

  it('answers for every role key', () => {
    for (const r of ROLE_KEYS) expect(['forbidden', 'required', 'optional']).toContain(roleScopeRule(r));
  });
});

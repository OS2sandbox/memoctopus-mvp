import { describe, it, expect } from 'vitest';
import { roleScopeRule } from './role-rules';

describe('roleScopeRule', () => {
  it('pins the rule per role', () => {
    expect(roleScopeRule('bruger')).toBe('forbidden');
    expect(roleScopeRule('bygger')).toBe('optional'); // global = the superuser who manages every shared prompt
    expect(roleScopeRule('admin')).toBe('forbidden'); // access.manage/sync.run are global-only
  });
});

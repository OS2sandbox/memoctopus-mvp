import { describe, it, expect } from 'vitest';
import { isMeResponse, meToPrincipal, visibleSectionsForMe, type MeResponse } from './me';

const base: MeResponse = {
  user: { id: 'u1', name: 'Anne', email: 'a@example.dk' },
  roles: ['tt-bruger'],
  capabilities: ['template.use'],
  scopes: {},
  source: 'local',
  readOnly: false,
};

describe('isMeResponse', () => {
  it('accepts a well-formed body', () => {
    expect(isMeResponse(base)).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['no user', { ...base, user: undefined }],
    ['roles not an array', { ...base, roles: 'tt-bruger' }],
    ['capabilities missing', { ...base, capabilities: undefined }],
    ['unknown source', { ...base, source: 'baseline' }],
    ['readOnly not boolean', { ...base, readOnly: 'false' }],
  ])('rejects %s', (_label, value) => {
    expect(isMeResponse(value)).toBe(false);
  });
});

describe('visibleSectionsForMe', () => {
  it('shows no admin section to a plain user', () => {
    expect(visibleSectionsForMe(base)).toEqual([]);
  });

  it('shows overview and organisation to a directory reader only', () => {
    const me = { ...base, capabilities: ['template.use', 'directory.read'] as MeResponse['capabilities'] };
    expect(visibleSectionsForMe(me).map((s) => s.key)).toEqual(['overview', 'organisation']);
  });

  it('shows overview, users and organisation to an access manager', () => {
    const me = {
      ...base,
      capabilities: ['template.use', 'access.manage', 'directory.read'] as MeResponse['capabilities'],
    };
    expect(visibleSectionsForMe(me).map((s) => s.key)).toEqual(['overview', 'users', 'organisation']);
  });

  it('shows the overview and the templates section to a template manager', () => {
    const me = { ...base, capabilities: ['template.use', 'template.manage'] as MeResponse['capabilities'] };
    expect(visibleSectionsForMe(me).map((s) => s.key)).toEqual(['overview', 'templates']);
  });
});

describe('meToPrincipal', () => {
  it('never marks the principal disabled', () => {
    expect(meToPrincipal(base).disabled).toBe(false);
  });
});

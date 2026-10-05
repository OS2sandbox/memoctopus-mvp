import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeRunner } from '@/test/fake-runner';

vi.mock('@/lib/db', () => ({ pool: {} }));

import { CLAIM_WHITELIST, captureExternalIdentity, decodeJwtPayload, pickClaims } from './identity';

function jwt(payload: unknown): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc(payload)}.signature`;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('decodeJwtPayload', () => {
  it('decodes base64url payloads including non-ASCII', () => {
    expect(decodeJwtPayload(jwt({ name: 'Søren Ærø' }))).toEqual({ name: 'Søren Ærø' });
  });
  it.each(['', 'abc', 'a.b', 'a.!!!.c', `a.${Buffer.from('[1]').toString('base64url')}.c`, `a.${Buffer.from('"x"').toString('base64url')}.c`])(
    'returns null for malformed token %j',
    (token) => {
      expect(decodeJwtPayload(token)).toBeNull();
    },
  );
});

describe('pickClaims', () => {
  it('keeps only whitelisted claims', () => {
    const picked = pickClaims({
      sub: 's1',
      email: 'a@example.dk',
      email_verified: true,
      preferred_username: 'abc',
      upn: 'a@corp.dk',
      oid: 'o1',
      tid: 't1',
      name: 'A',
      groups: ['g1'],
      roles: ['admin'],
      wids: ['x'],
      unknown_claim: 'x',
      cpr: '0000000000',
    });
    expect(Object.keys(picked).sort()).toEqual([...CLAIM_WHITELIST].sort());
    expect(picked).not.toHaveProperty('groups');
    expect(picked).not.toHaveProperty('roles');
    expect(picked).not.toHaveProperty('unknown_claim');
  });

  it('drops wrongly typed values and only accepts a real boolean for email_verified', () => {
    expect(pickClaims({ sub: 5, email: ['a'], email_verified: 'true', name: '' })).toEqual({});
    expect(pickClaims({ email_verified: false })).toEqual({ email_verified: false });
  });
});

describe('captureExternalIdentity', () => {
  it('queries only non-credential accounts', async () => {
    const { runner, calls } = makeFakeRunner();
    await captureExternalIdentity('u1', runner);
    expect(calls[0].sql).toContain("provider_id <> 'credential'");
    expect(calls[0].params).toEqual(['u1']);
  });

  it('upserts a whitelisted snapshot and never the token or extra claims', async () => {
    const token = jwt({ sub: 'sub-1', email: 'a@example.dk', email_verified: true, groups: ['g'], secret: 'zzz' });
    const { runner, calls } = makeFakeRunner((sql) => {
      if (sql.includes('FROM public.accounts')) return [{ provider_id: 'oidc', id_token: token }];
      if (sql.includes('INSERT INTO public.external_identities')) return [{ id: 'x' }];
    });
    const out = await captureExternalIdentity('u1', runner);

    expect(out).toEqual([
      { userId: 'u1', providerId: 'oidc', subject: 'sub-1', claims: { sub: 'sub-1', email: 'a@example.dk', email_verified: true } },
    ]);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO'))!;
    expect(insert.params.slice(0, 3)).toEqual(['u1', 'oidc', 'sub-1']);
    const stored = JSON.parse(insert.params[3] as string);
    expect(stored).toEqual({ sub: 'sub-1', email: 'a@example.dk', email_verified: true });
    expect(JSON.stringify(insert.params)).not.toContain(token);
    expect(JSON.stringify(insert.params)).not.toContain('zzz');
  });

  it('tolerates a malformed token, continues with other accounts and logs no claim values', async () => {
    const good = jwt({ sub: 's2' });
    const { runner, calls } = makeFakeRunner((sql) => {
      if (sql.includes('FROM public.accounts'))
        return [
          { provider_id: 'oidc', id_token: 'not-a-jwt' },
          { provider_id: 'microsoft', id_token: good },
        ];
      if (sql.includes('INSERT INTO')) return [{ id: 'x' }];
    });
    const out = await captureExternalIdentity('u1', runner);
    expect(out.map((i) => i.providerId)).toEqual(['microsoft']);
    expect(calls.filter((c) => c.sql.includes('INSERT INTO'))).toHaveLength(1);
    expect(JSON.stringify((console.warn as any).mock.calls)).not.toContain('not-a-jwt');
  });

  it('skips tokens without sub', async () => {
    const { runner, calls } = makeFakeRunner((sql) =>
      sql.includes('FROM public.accounts') ? [{ provider_id: 'oidc', id_token: jwt({ email: 'a@example.dk' }) }] : [],
    );
    expect(await captureExternalIdentity('u1', runner)).toEqual([]);
    expect(calls.some((c) => c.sql.includes('INSERT INTO'))).toBe(false);
  });

  it('does not report an identity as captured when the row is bound to another user', async () => {
    const { runner } = makeFakeRunner((sql) =>
      sql.includes('FROM public.accounts') ? [{ provider_id: 'oidc', id_token: jwt({ sub: 's' }) }] : [],
    );
    expect(await captureExternalIdentity('u1', runner)).toEqual([]);
  });
});

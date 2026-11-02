import { describe, expect, it, vi } from 'vitest';

// graph-client pulls in better-auth, which needs a real DB.
vi.mock('@/lib/auth', () => ({ auth: { api: {} } }));
vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));

import { CODE_RE } from '@/lib/audit/events/types';
import { teamsFailureCode } from './failure-code';
import { GraphError } from './graph-client';
import { ResolveError } from './meeting-resolver';

describe('teamsFailureCode', () => {
  it('uses the GraphError code, or http_<status> for a plain HTTP failure', () => {
    expect(teamsFailureCode(new GraphError('forbidden', 'Ingen adgang for Jens', { status: 403 }))).toBe('forbidden');
    expect(teamsFailureCode(new GraphError('consent_required', 'x', { status: 403 }))).toBe('consent_required');
    expect(teamsFailureCode(new GraphError('http', 'x', { status: 502 }))).toBe('http_502');
    expect(teamsFailureCode(new GraphError('http', 'x', { status: 0 }))).toBe('http');
  });

  it('names a join link that could not be resolved', () => {
    expect(teamsFailureCode(new ResolveError('invalid-url'))).toBe('resolve_invalid_url');
    expect(teamsFailureCode(new ResolveError('not_invited'))).toBe('resolve_not_invited');
  });

  it('never forwards a message: anything else is unknown, and every code fits the audit vocabulary', () => {
    expect(teamsFailureCode(new Error('Kvartalsrapport.docx kunne ikke åbnes'))).toBe('unknown');
    expect(teamsFailureCode('boom')).toBe('unknown');
    expect(teamsFailureCode(null)).toBe('unknown');
    for (const e of [new GraphError('unavailable', 'm', { status: 503 }), new ResolveError('wrong-host'), new Error('x')]) {
      expect(teamsFailureCode(e)).toMatch(CODE_RE);
    }
  });
});

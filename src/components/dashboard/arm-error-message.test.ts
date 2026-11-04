import { describe, it, expect } from 'vitest';
import { armErrorMessage } from './arm-error-message';

describe('armErrorMessage', () => {
  // The server sends a Danish, user-safe `message` with every typed error
  // (src/lib/teams/http-errors.ts). The client's own list missed several codes
  // (forbidden, not_found, unavailable …), each of which then read as a generic
  // "Prøv igen" — so the server's sentence comes first.
  it('uses the message the server sent', () => {
    const message = 'Microsoft Graph svarer ikke lige nu. Prøv igen om lidt.';
    expect(armErrorMessage(503, { error: 'unavailable', message })).toBe(message);
    expect(armErrorMessage(403, { error: 'forbidden', message: 'Ingen adgang til denne ressource' }))
      .toBe('Ingen adgang til denne ressource');
  });

  it('prefers the server message over its own copy for a known code', () => {
    expect(armErrorMessage(404, { error: 'not_invited', message: 'Du er ikke inviteret.' }))
      .toBe('Du er ikke inviteret.');
  });

  it('ignores a blank server message', () => {
    expect(armErrorMessage(400, { error: 'invalid-url', message: '  ' })).toMatch(/gyldigt Teams-link/);
  });

  // Not every answer carries a message: the route's own validation errors and
  // the session check do not.
  it('maps every known error code to Danish copy when there is no message', () => {
    expect(armErrorMessage(400, { error: 'invalid-url' })).toMatch(/gyldigt Teams-link/);
    expect(armErrorMessage(400, { error: 'wrong-host' })).toMatch(/gyldigt Teams-link/);
    expect(armErrorMessage(404, { error: 'not_invited' })).toMatch(/inviteret til mødet/);
    expect(armErrorMessage(403, { error: 'reauth_required' })).toMatch(/udløbet/);
    expect(armErrorMessage(403, { error: 'transcripts_disabled' })).toMatch(/IT-administrator/);
    expect(armErrorMessage(403, { error: 'disabled' })).toMatch(/ikke slået til/);
  });

  it('falls back on an unknown error and distinguishes 401', () => {
    expect(armErrorMessage(502, { error: 'graph' })).toMatch(/Prøv igen/);
    expect(armErrorMessage(409, { error: 'meeting-id-taken' })).toMatch(/Prøv igen/);
    expect(armErrorMessage(401)).toMatch(/ikke logget ind/);
  });
});

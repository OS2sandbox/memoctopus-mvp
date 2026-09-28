import { describe, it, expect } from 'vitest';
import { armErrorMessage } from './arm-error-message';

describe('armErrorMessage', () => {
  it('maps every known error code to Danish copy', () => {
    expect(armErrorMessage(400, 'invalid-url')).toMatch(/gyldigt Teams-link/);
    expect(armErrorMessage(400, 'wrong-host')).toMatch(/gyldigt Teams-link/);
    expect(armErrorMessage(404, 'not_invited')).toMatch(/inviteret til mødet/);
    expect(armErrorMessage(403, 'reauth_required')).toMatch(/udløbet/);
    expect(armErrorMessage(403, 'transcripts_disabled')).toMatch(/IT-administrator/);
    expect(armErrorMessage(403, 'disabled')).toMatch(/ikke slået til/);
  });

  it('falls back on an unknown error and distinguishes 401', () => {
    expect(armErrorMessage(502, 'graph')).toMatch(/Prøv igen/);
    expect(armErrorMessage(401)).toMatch(/ikke logget ind/);
  });
});

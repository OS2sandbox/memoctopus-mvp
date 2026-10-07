// Typed errors of the local access provider. Kept apart from access-admin.ts so
// route tests can mock the service and still use the real classes.

import type { AccessSource } from './config';

export const READ_ONLY_MESSAGE = 'Skrivebeskyttet: roller og organisation styres af Rollekatalog';

/** Why the write was refused, by what owns the roles (or, in local mode, the operator's kill switch). */
export function readOnlyMessage(source?: AccessSource): string {
  switch (source) {
    case 'claims':
      return 'Skrivebeskyttet: roller styres af identitetsudbyderen';
    case 'local':
      return 'Skrivebeskyttet: lokal rolleadministration er slået fra';
    default:
      return READ_ONLY_MESSAGE;
  }
}

export class AccessError extends Error {
  /** Short machine code; safe to return to the client. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class NotFoundError extends AccessError {
  constructor(message = 'Ikke fundet', code = 'not_found') {
    super(code, message);
  }
}

export class ConflictError extends AccessError {
  constructor(message: string, code = 'conflict') {
    super(code, message);
  }
}

/** Optimistic-concurrency miss: someone else changed the row first. Carries the version that is current now. */
export class VersionConflictError extends ConflictError {
  readonly currentVersion: number;
  constructor(currentVersion: number, message = 'Skabelonen er ændret af en anden. Hent den igen og prøv igen.') {
    super(message, 'version_conflict');
    this.currentVersion = currentVersion;
  }
}

export class ValidationError extends AccessError {
  constructor(message: string, code = 'invalid') {
    super(code, message);
  }
}

export class ReadOnlyModeError extends AccessError {
  constructor(source?: AccessSource) {
    super('read_only', readOnlyMessage(source));
  }
}

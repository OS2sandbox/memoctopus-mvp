// Short, closed error codes for everything the Rollekatalog client can fail with.
// The error carries ONLY the code (and the HTTP status when there was one): never
// a URL with its query string, a header, a key or a response body, because those
// can hold secrets or personal data and errors end up in logs and audit rows.

export const ROLLEKATALOG_ERROR_CODES = [
  'not_configured',
  'insecure_url',
  'unauthorized',
  'forbidden',
  'not_found',
  'timeout',
  'network',
  'server_error',
  'invalid_response',
  'too_large',
] as const;
export type RollekatalogErrorCode = (typeof ROLLEKATALOG_ERROR_CODES)[number];

export class RollekatalogError extends Error {
  readonly code: RollekatalogErrorCode;
  /** The HTTP status when the server answered, else null. */
  readonly httpStatus: number | null;

  constructor(code: RollekatalogErrorCode, httpStatus: number | null = null) {
    super(`rollekatalog:${code}`);
    this.name = 'RollekatalogError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function isRollekatalogError(err: unknown): err is RollekatalogError {
  return err instanceof RollekatalogError;
}

/** The short code for any thrown value; 'unexpected' for anything that is not a RollekatalogError. */
export function errorCodeOf(err: unknown): RollekatalogErrorCode | 'unexpected' {
  return isRollekatalogError(err) ? err.code : 'unexpected';
}

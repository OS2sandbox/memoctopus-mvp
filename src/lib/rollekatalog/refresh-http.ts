// Maps the result of a Rollekatalog pull (user/organisation sync, role/group catalogue refresh) to an
// HTTP response, shared by the cron routes and the admin buttons. Bodies carry only the status,
// counters and short codes: never a key, a URL or data from Rollekatalog.
import { NextResponse } from 'next/server';

export interface RefreshResultLike {
  status: 'success' | 'already_running' | 'aborted' | 'error';
  counts: unknown;
  /** A short code ('timeout', 'removal_threshold', ...); null on success. */
  errorCode: string | null;
}

// Codes that mean the upstream (or its configuration) is at fault rather than this app.
export const UPSTREAM_CODES = new Set([
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
]);

export function refreshHttpStatus(result: RefreshResultLike): number {
  switch (result.status) {
    case 'success':
      return 200;
    case 'already_running':
      return 409;
    case 'aborted':
      return 502;
    case 'error':
      return result.errorCode && UPSTREAM_CODES.has(result.errorCode) ? 502 : 500;
  }
}

/** `friendly` adds the Danish `error`/`code` pair (from `messageFor`) that the admin UI shows verbatim. */
export function refreshResultResponse(
  result: RefreshResultLike,
  friendly: boolean,
  messageFor: (code: string | null) => string,
): NextResponse {
  const errorCode = result.status === 'already_running' ? (result.errorCode ?? 'already_running') : result.errorCode;
  const body: Record<string, unknown> = { status: result.status, counts: result.counts, errorCode };
  if (friendly && result.status !== 'success') {
    body.error = messageFor(errorCode);
    body.code = errorCode ?? 'unexpected';
  }
  return NextResponse.json(body, { status: refreshHttpStatus(result), headers: { 'Cache-Control': 'no-store' } });
}

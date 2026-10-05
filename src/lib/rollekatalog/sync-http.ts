// Maps a SyncResult to an HTTP response, shared by the cron route and the admin
// button. Bodies carry only the status, counters and short codes. Never a key,
// a URL or data from Rollekatalog.
import { NextResponse } from 'next/server';
import { syncErrorMessage } from './labels.da';
import type { SyncResult } from './types';

// Codes that mean the upstream (or its configuration) is at fault rather than this app.
const UPSTREAM_CODES = new Set([
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

export function syncHttpStatus(result: SyncResult): number {
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

/** `friendly` adds the Danish `error`/`code` pair that the admin UI shows verbatim. */
export function syncResultResponse(result: SyncResult, friendly: boolean): NextResponse {
  const errorCode = result.status === 'already_running' ? (result.errorCode ?? 'already_running') : result.errorCode;
  const body: Record<string, unknown> = { status: result.status, counts: result.counts, errorCode };
  if (friendly && result.status !== 'success') {
    body.error = syncErrorMessage(errorCode);
    body.code = errorCode ?? 'unexpected';
  }
  return NextResponse.json(body, { status: syncHttpStatus(result), headers: { 'Cache-Control': 'no-store' } });
}

// Maps a CatalogueRefreshResult to an HTTP response, shared by the cron route and the admin
// button. Bodies carry only the status, counters and short codes: never a key, a URL or
// data from Rollekatalog.
import { NextResponse } from 'next/server';
import type { CatalogueRefreshResult } from './catalogue-sync';
import { catalogueErrorMessage } from './labels.da';

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

export function catalogueHttpStatus(result: CatalogueRefreshResult): number {
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
export function catalogueResultResponse(result: CatalogueRefreshResult, friendly: boolean): NextResponse {
  const body: Record<string, unknown> = { status: result.status, counts: result.counts, errorCode: result.errorCode };
  if (friendly && result.status !== 'success') {
    body.error = catalogueErrorMessage(result.errorCode);
    body.code = result.errorCode ?? 'unexpected';
  }
  return NextResponse.json(body, { status: catalogueHttpStatus(result), headers: { 'Cache-Control': 'no-store' } });
}

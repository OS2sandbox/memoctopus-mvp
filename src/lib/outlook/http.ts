import { NextResponse } from 'next/server';
import { teamsErrorResponse } from '@/lib/teams/http-errors';
import { AddinAuthError } from './addin-auth';

/**
 * Error responses for the add-in's routes: its own auth failures, then the Teams
 * integration's usual mapping (GraphError, ResolveError). Every body carries a
 * Danish `message` the pane can show as it is.
 */
export function addinErrorResponse(err: unknown): NextResponse {
  if (err instanceof AddinAuthError) {
    if (err.cause) console.warn(`[outlook] refused (${err.code}):`, err.cause);
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  return teamsErrorResponse(err);
}

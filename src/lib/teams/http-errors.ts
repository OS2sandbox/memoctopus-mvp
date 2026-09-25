import { NextResponse } from 'next/server';
import { GraphError } from './graph-client';
import { ResolveError } from './meeting-resolver';

/**
 * Single place where the typed errors from `src/lib/teams/*` become HTTP
 * responses, so every /api/teams route answers with the same status codes and
 * the same Danish, user-safe `message`.
 */
export function teamsErrorResponse(err: unknown): NextResponse {
  if (err instanceof ResolveError) {
    const status = err.code === 'not_invited' ? 404 : 400;
    return NextResponse.json({ error: err.code, message: err.message }, { status });
  }

  if (err instanceof GraphError) {
    switch (err.code) {
      case 'consent_required':
        return NextResponse.json(
          { error: 'consent_required', missing: err.missingScopes ?? [], message: err.message },
          { status: 403 },
        );
      case 'reauth_required':
        return NextResponse.json({ error: 'reauth_required', message: err.message }, { status: 403 });
      case 'disabled':
        return NextResponse.json({ error: 'disabled', message: err.message }, { status: 403 });
      case 'transcripts_disabled':
        return NextResponse.json({ error: 'transcripts_disabled', message: err.message }, { status: 403 });
      case 'forbidden':
        return NextResponse.json({ error: 'forbidden', message: err.message }, { status: 403 });
      case 'not_found':
        return NextResponse.json({ error: 'not_found', message: err.message }, { status: 404 });
      case 'unavailable':
        // Transient (throttle, outage, timeout): the same request is worth repeating.
        return NextResponse.json({ error: 'unavailable', message: err.message }, { status: 503 });
      default:
        return NextResponse.json({ error: 'graph', message: err.message }, { status: 502 });
    }
  }

  console.error('[api/teams] unexpected error:', err);
  return NextResponse.json(
    { error: 'internal', message: 'Der opstod en uventet fejl. Prøv igen.' },
    { status: 500 },
  );
}

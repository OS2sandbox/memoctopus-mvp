import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { asHeaderSource, requestIdOf } from '@/lib/audit/request-context';
import { safeLogError } from '@/lib/audit/safe-log';

/**
 * Wraps a route handler so any uncaught error is logged with a stable label and
 * returned as a parseable JSON 500 — instead of a bare Next.js HTML error page,
 * which makes the client's `res.json()` throw ("Unexpected token '<'"). Keeps
 * every route traceable: one `[label]` line in the server logs per failure.
 *
 * The line carries only the error's name, HTTP status and code (safeLogError),
 * never its message: errors from LLM/STT clients can echo prompt or transcript
 * text. It also carries a request id (the caller's x-request-id, or a generated
 * one) that is returned in the x-request-id response header, so a user-reported
 * failure can be matched to the log line.
 *
 *   export const POST = withHandler('minutes', async (req: NextRequest) => { ... });
 */
export function withHandler<TArgs extends unknown[]>(
  label: string,
  handler: (...args: TArgs) => Response | Promise<Response>,
): (...args: TArgs) => Promise<Response> {
  return async (...args: TArgs) => {
    try {
      return await handler(...args);
    } catch (err) {
      const source = asHeaderSource(args[0]);
      const requestId = source ? requestIdOf(source) : randomUUID();
      safeLogError(label, err, requestId);
      // An invalid security setting: fail closed with a clear 503 (the log line carries only "ConfigError").
      // Matched by name (ConfigError, src/lib/authz/config.ts) so this module needs no authz import.
      if (err instanceof Error && err.name === 'ConfigError') {
        return NextResponse.json(
          { error: 'Adgangskontrol er midlertidigt utilgængelig', code: 'config_invalid' },
          { status: 503, headers: { 'x-request-id': requestId } },
        );
      }
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500, headers: { 'x-request-id': requestId } },
      );
    }
  };
}

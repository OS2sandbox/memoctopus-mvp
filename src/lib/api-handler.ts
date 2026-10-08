import { NextResponse } from 'next/server';
import { UserFacingError } from '@/lib/user-facing-error';

/**
 * Wraps a route handler so any uncaught error is logged with a stable label and
 * returned as a parseable JSON 500 — instead of a bare Next.js HTML error page,
 * which makes the client's `res.json()` throw ("Unexpected token '<'"). Keeps
 * every route traceable: one `[label]` line in the server logs per failure.
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
      console.error(`[${label}]`, err);
      if (err instanceof UserFacingError) {
        return NextResponse.json({ error: err.userMessage }, { status: err.status });
      }
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  };
}

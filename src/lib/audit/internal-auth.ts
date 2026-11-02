// Service-to-service authentication for the cron routes and the bot callbacks.
// No cookies and no session are involved. Secrets are never logged or echoed,
// and the comparisons are constant-time.
import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { internalCronSecret } from './config';

/** The one header the cron secret is read from. */
export const CRON_SECRET_HEADER = 'x-cron-secret';

// A real key is short; refusing long values keeps the hash input bounded.
const MAX_SECRET_LENGTH = 512;

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** Constant-time equality of two secrets (both are hashed first, so length does not leak). */
export function secretEquals(provided: string, expected: string): boolean {
  return timingSafeEqual(sha256(provided), sha256(expected));
}

const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 });
const UNAUTHORIZED = () =>
  NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });

/** null when the request carries INTERNAL_CRON_SECRET; otherwise the 404 (secret unset) or 401 response. */
export function cronGuard(req: { headers: { get(name: string): string | null } }): NextResponse | null {
  const expected = internalCronSecret();
  if (!expected) return NOT_FOUND();
  const provided = req.headers.get(CRON_SECRET_HEADER);
  if (!provided || provided.length > MAX_SECRET_LENGTH || !secretEquals(provided, expected)) return UNAUTHORIZED();
  return null;
}

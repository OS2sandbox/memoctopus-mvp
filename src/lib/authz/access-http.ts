import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { ZodTypeAny, z } from 'zod';
import { accessSource } from './config';
import { AccessError, ConflictError, NotFoundError, READ_ONLY_MESSAGE, ReadOnlyModeError, ValidationError } from './access-errors';

const STATUS: Array<[new (...args: never[]) => AccessError, number]> = [
  [NotFoundError, 404],
  [ValidationError, 400],
  [ConflictError, 409],
  [ReadOnlyModeError, 409],
];

/** Maps a typed access error to a JSON response; anything else is rethrown (withAuthz turns it into the standard 500). */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AccessError) {
    const status = STATUS.find(([cls]) => err instanceof cls)?.[1] ?? 400;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  throw err;
}

/** Wrap a service call so its typed errors become responses. */
export async function respond(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** 409 when roles/organisation are owned by Rollekatalog; call first in every write handler. */
export function readOnlyResponse(): NextResponse | null {
  return accessSource() === 'local'
    ? null
    : NextResponse.json({ error: READ_ONLY_MESSAGE, code: 'read_only' }, { status: 409 });
}

type Parsed<S extends ZodTypeAny> = { ok: true; data: z.infer<S> } | { ok: false; response: NextResponse };

// Issues carry path and zod code only: messages can echo the offending input.
function invalid(error: z.ZodError): NextResponse {
  return NextResponse.json(
    {
      error: 'Ugyldigt input',
      code: 'invalid',
      issues: error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
    },
    { status: 400 },
  );
}

export function parseWith<S extends ZodTypeAny>(schema: S, value: unknown): Parsed<S> {
  const r = schema.safeParse(value);
  return r.success ? { ok: true, data: r.data } : { ok: false, response: invalid(r.error) };
}

export async function parseJsonBody<S extends ZodTypeAny>(req: NextRequest, schema: S): Promise<Parsed<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Ugyldig JSON', code: 'invalid_json' }, { status: 400 }) };
  }
  return parseWith(schema, raw);
}

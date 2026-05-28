import { NextRequest } from 'next/server';

export const FAKE_SESSION = { user: { id: 'user-123' } } as const;

export function makeJsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

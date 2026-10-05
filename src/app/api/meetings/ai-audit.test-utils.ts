// Test helper for the AI/export routes: checks a recorded event against the real
// catalogue and asserts that none of the given content strings leaked into it.
import { expect } from 'vitest';
import { validateEvent } from '@/lib/audit/record';

export function expectValidMetadataOnly(event: unknown, forbidden: string[] = []): void {
  const result = validateEvent(event as Parameters<typeof validateEvent>[0]);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  const json = JSON.stringify(event);
  for (const text of forbidden) expect(json).not.toContain(text);
}

/** An error shaped like an LLM/STT client failure whose message echoes content. */
export function leakyError(secret: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`Request failed: ${secret}`), extra);
}

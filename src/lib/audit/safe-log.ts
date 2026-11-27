// App-log helper for failures. LLM/STT/HTTP client errors can echo the prompt or
// transcript in `message`, `body`, `cause` or `stack`, so none of those is ever
// printed: only the error class name, a numeric HTTP status and a short code.
import { CODE_RE } from './events/types';

interface SafeErrorInfo {
  name: string;
  status?: number;
  code?: string;
}

function safeName(err: unknown): string {
  if (err instanceof Error && /^[A-Za-z0-9_$]{1,64}$/.test(err.name)) return err.name;
  return err instanceof Error ? 'Error' : typeof err;
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null;
  for (const v of [e?.status, e?.statusCode, e?.response?.status]) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599) return v;
  }
  return undefined;
}

function codeOf(err: unknown): string | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  // Whitespace-free short codes only (ECONNRESET, 23505, invalid_api_key); free text is dropped.
  return typeof c === 'string' && CODE_RE.test(c) ? c : undefined;
}

export function describeError(err: unknown): SafeErrorInfo {
  return { name: safeName(err), status: statusOf(err), code: codeOf(err) };
}

/** `[label] name=APIError status=429 code=rate_limit_exceeded requestId=...`; never message, body, cause or stack. */
export function safeLogError(label: string, err: unknown, requestId?: string): void {
  const { name, status, code } = describeError(err);
  const parts = [`name=${name}`];
  if (status !== undefined) parts.push(`status=${status}`);
  if (code !== undefined) parts.push(`code=${code}`);
  if (requestId) parts.push(`requestId=${requestId}`);
  console.error(`[${label}] ${parts.join(' ')}`);
}

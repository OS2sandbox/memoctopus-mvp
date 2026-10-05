// Small fetch wrapper for the admin API. Typed access errors from the server
// carry a Danish `error` plus a `code`; anything else (401/403/500 bodies are
// English or generic) is replaced by a fixed Danish message so the UI never
// shows raw server text it did not expect.

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

const FALLBACK: Record<number, string> = {
  401: 'Din session er udløbet. Log ind igen.',
  403: 'Du har ikke adgang til denne handling.',
  404: 'Ikke fundet.',
};

export const NETWORK_ERROR = 'Netværksfejl. Prøv igen.';
const GENERIC_ERROR = 'Noget gik galt. Prøv igen.';

export function messageFromBody(status: number, body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const b = body as { error?: unknown; code?: unknown };
    if (typeof b.error === 'string' && typeof b.code === 'string' && b.error.length > 0) return b.error;
  }
  return FALLBACK[status] ?? GENERIC_ERROR;
}

export async function apiRequest<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<ApiResult<T>> {
  const { json, ...rest } = init ?? {};
  const options: RequestInit = { ...rest };
  if (json !== undefined) {
    options.body = JSON.stringify(json);
    options.headers = { 'Content-Type': 'application/json', ...(rest.headers as Record<string, string> | undefined) };
  }
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch {
    return { ok: false, status: 0, message: NETWORK_ERROR };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Empty or non-JSON body: handled by the status below.
  }
  if (!res.ok) return { ok: false, status: res.status, message: messageFromBody(res.status, body) };
  return { ok: true, data: body as T };
}

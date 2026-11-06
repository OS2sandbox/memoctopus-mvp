/**
 * The add-in's two calls to OS2taletiltekst. Same origin as the pane, so no CORS;
 * authenticated by the NAA token alone (no cookies are sent or needed).
 */

export interface ArmResponse {
  id: string;
  subject: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  isOrganizer: boolean;
  armed: boolean;
  armResult: string;
  alreadyRegistered: boolean;
  /** Registered in the dashboard already: switched on, but not the add-in's to switch off. */
  managedInDashboard: boolean;
}

/** A refusal from the server, carrying its Danish message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(path: string, init: RequestInit, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'omit',
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ApiError('Kunne ikke få forbindelse til OS2taletiltekst. Er du på kommunens netværk?', 'network', 0);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    throw new ApiError(
      body.message || 'OS2taletiltekst kunne ikke slå mødet til. Prøv igen om lidt.',
      body.error ?? 'http',
      res.status,
    );
  }
  return body as T;
}

export function armMeeting(
  joinUrl: string,
  times: { start: Date; end: Date } | null,
  token: string,
): Promise<ArmResponse> {
  const body = { joinUrl, ...(times ? { start: times.start.toISOString(), end: times.end.toISOString() } : {}) };
  return call<ArmResponse>(
    '/api/outlook/meetings',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    token,
  );
}

export function disarmMeeting(id: string, token: string): Promise<{ ok: true; disarmed: boolean }> {
  return call(`/api/outlook/meetings/${encodeURIComponent(id)}`, { method: 'DELETE' }, token);
}

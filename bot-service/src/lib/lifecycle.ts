// Best-effort lifecycle reports (ended / error) to the Next app, so the app's audit
// log can show how a bot session finished. Joining is not reported (not audited). Hard rules: the report carries only the
// user id, the meeting id and a short code (never the meeting URL, a title or a
// participant name), it can never throw, and it never delays or fails a session:
// short timeout, no retries, failures are logged by status/name only.

export type LifecycleEvent = 'ended' | 'error';

export interface LifecycleReporterOptions {
  /** Full URL of POST /api/bot/lifecycle. Reporting is a no-op without it. */
  url?: string;
  secret: string;
  userId: string;
  meetingId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface LifecycleReporter {
  /** At most one terminal report (ended or error) is sent per session. */
  ended(code?: string): void;
  error(code: string): void;
}

const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 3000;

async function send(opts: LifecycleReporterOptions, event: LifecycleEvent, code?: string): Promise<void> {
  if (!opts.url) return;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  try {
    const res = await doFetch(opts.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: opts.userId,
        meetingId: opts.meetingId,
        event,
        ...(code && CODE_RE.test(code) ? { code } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) console.warn(`[bot] lifecycle report event=${event} rejected status=${res.status}`);
  } catch (err) {
    // Name only: a fetch error message can include the target URL.
    console.warn(`[bot] lifecycle report event=${event} failed name=${err instanceof Error ? err.name : 'unknown'}`);
  }
}

export function createLifecycleReporter(opts: LifecycleReporterOptions): LifecycleReporter {
  let terminalSent = false;
  // Fire and forget: `send` never rejects, and callers must not wait on the Next app.
  const fire = (event: LifecycleEvent, code?: string) => {
    void send(opts, event, code);
  };
  return {
    ended(code) {
      if (terminalSent) return;
      terminalSent = true;
      fire('ended', code);
    },
    error(code) {
      if (terminalSent) return;
      terminalSent = true;
      fire('error', code);
    },
  };
}

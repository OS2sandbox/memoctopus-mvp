import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLifecycleReporter } from '../../src/lib/lifecycle';

const URL_ = 'http://next.test/api/bot/lifecycle';
const MEETING = '11111111-1111-4111-8111-111111111111';

function make(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createLifecycleReporter>[0]> = {}) {
  return createLifecycleReporter({
    url: URL_,
    secret: 's3cret',
    userId: 'user-1',
    meetingId: MEETING,
    fetchImpl,
    ...extra,
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('lifecycle reporter', () => {
  it('posts only ids, the event and a short code, authenticated with the shared secret', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const r = make(fetchImpl as unknown as typeof fetch);
    r.ended('meeting_ended');
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(URL_);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer s3cret');
    expect(JSON.parse(init.body)).toEqual({
      userId: 'user-1', meetingId: MEETING, event: 'ended', code: 'meeting_ended',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('drops a code that is not a short code instead of sending free text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'));
    make(fetchImpl as unknown as typeof fetch).error('Navigation timeout at https://teams.microsoft.com/x');
    await flush();
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty('code');
  });

  it('sends joined once and at most one terminal event per session', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'));
    const r = make(fetchImpl as unknown as typeof fetch);
    r.joined();
    r.joined();
    r.error('start_failed');
    r.ended('stopped');
    r.error('again');
    r.joined();
    await flush();
    const events = fetchImpl.mock.calls.map((c) => JSON.parse(c[1].body).event);
    expect(events).toEqual(['joined', 'error']);
  });

  it('never throws and never rejects when the Next app is unreachable, logging the error name only', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED http://next.test/secret-path'));
    const r = make(fetchImpl as unknown as typeof fetch);
    expect(() => r.joined()).not.toThrow();
    await flush();
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('name=Error');
    expect(logged).not.toContain('next.test');
  });

  it('does not wait for the response (the call returns before fetch settles)', () => {
    const fetchImpl = vi.fn().mockReturnValue(new Promise(() => {}));
    const r = make(fetchImpl as unknown as typeof fetch);
    const t = Date.now();
    r.ended('stopped');
    expect(Date.now() - t).toBeLessThan(50);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('logs a non-2xx status without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('no', { status: 500 }));
    make(fetchImpl as unknown as typeof fetch).joined();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('status=500');
  });

  it('is a no-op without a url', async () => {
    const fetchImpl = vi.fn();
    make(fetchImpl as unknown as typeof fetch, { url: undefined }).joined();
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts a hung request after the timeout', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('t', 'TimeoutError')))),
    );
    make(fetchImpl as unknown as typeof fetch, { timeoutMs: 20 }).joined();
    await new Promise((r) => setTimeout(r, 80));
    expect(warn.mock.calls.flat().join(' ')).toContain('name=TimeoutError');
  });
});

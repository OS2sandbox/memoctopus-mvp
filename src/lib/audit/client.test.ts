// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queue: [] as Array<Record<string, any>>,
  available: true,
  addFails: false,
  failed: [] as string[][],
}));

vi.mock('./outbox', () => ({
  outboxAvailable: () => h.available,
  addToOutbox: vi.fn(async (u: string, ev: Record<string, any>) => {
    if (h.addFails) throw new Error('quota');
    h.queue.push({ ...ev, attempts: 0, owner: u });
    return true;
  }),
  // Like the real per-user outbox: a user only ever takes their own events.
  takeDue: vi.fn(async (u: string, limit: number) => h.queue.filter((e) => !e.owner || e.owner === u).slice(0, limit)),
  removeFromOutbox: vi.fn(async (_u: string, ids: string[]) => {
    h.queue = h.queue.filter((e) => !ids.includes(e.clientEventId));
  }),
  markFailed: vi.fn(async (_u: string, ids: string[]) => void h.failed.push(ids)),
}));

const MEETING = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';

type Client = typeof import('./client');
let c: Client;
let fetchMock: ReturnType<typeof vi.fn>;

const respond = (status: number) => ({ ok: status >= 200 && status < 300, status }) as Response;
const sentBodies = () => fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string).events as Array<Record<string, any>>);

async function load(userId: string | null = 'user-1') {
  c?.__resetAuditClient(); // removes the previous instance's window/document listeners
  vi.resetModules();
  const scope = await import('@/lib/storage/scope');
  scope.__resetStorageScope();
  if (userId) scope.setStorageUserId(userId);
  c = await import('./client');
}

beforeEach(async () => {
  vi.useFakeTimers();
  h.queue = [];
  h.available = true;
  h.addFails = false;
  h.failed = [];
  fetchMock = vi.fn(async () => respond(200));
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  await load();
});
afterEach(() => {
  c.__resetAuditClient();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reportAuditEvent', () => {
  it('queues an event with an id, type, entity, details and time, then delivers it with keepalive and removes it after a 2xx', async () => {
    c.reportAuditEvent('meeting.status_change', MEETING, { fromStatus: 'review', toStatus: 'minutes' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.queue).toHaveLength(1);
    expect(h.queue[0]).toMatchObject({ type: 'meeting.status_change', entityId: MEETING, details: { fromStatus: 'review', toStatus: 'minutes' } });
    expect(h.queue[0].clientEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(h.queue[0].occurredAt))).toBe(false);

    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/audit/client-events');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'same-origin' });
    // Only the wire fields leave: no queue bookkeeping, and no actor of any kind.
    expect(Object.keys(sentBodies()[0][0]).sort()).toEqual(['clientEventId', 'details', 'entityId', 'occurredAt', 'type']);
    expect(h.queue).toHaveLength(0);
  });

  it('keeps the event after a 5xx, a 429 or a network error, and counts the failed attempt', async () => {
    for (const outcome of [respond(500), respond(429), new Error('offline')]) {
      h.queue = [];
      h.failed = [];
      await load();
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      c.reportAuditEvent('meeting.delete', MEETING);
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.queue).toHaveLength(1);
      expect(h.failed).toHaveLength(1);
    }
  });

  it('keeps events while signed out (401) instead of discarding them', async () => {
    fetchMock.mockResolvedValue(respond(401));
    c.reportAuditEvent('meeting.delete', MEETING);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.queue).toHaveLength(1);
  });

  it('isolates a batch the server refuses for good: only the offending event is dropped', async () => {
    c.reportAuditEvent('meeting.delete', MEETING);
    c.reportAuditEvent('meeting.redact', OTHER);
    await vi.advanceTimersByTimeAsync(0);
    const [first, second] = h.queue.map((e) => e.clientEventId);
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) => {
      const events = JSON.parse(init.body as string).events as Array<{ clientEventId: string }>;
      return respond(events.length > 1 || events[0].clientEventId === first ? 400 : 200);
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.queue).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(3); // batch, then each one alone
    expect(first).not.toBe(second);
  });

  it('does not send while offline and sends on the online event', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    c.reportAuditEvent('meeting.delete', MEETING);
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchMock).not.toHaveBeenCalled();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.queue).toHaveLength(0);
  });

  it('retries from the periodic timer', async () => {
    fetchMock.mockResolvedValueOnce(respond(503));
    c.reportAuditEvent('meeting.delete', MEETING);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.queue).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.queue).toHaveLength(0);
  });

  it('flushes when the tab becomes hidden', async () => {
    c.reportAuditEvent('meeting.delete', MEETING);
    await vi.advanceTimersByTimeAsync(0);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('startAuditReporting delivers what an earlier page load left in the queue', async () => {
    h.queue.push({ clientEventId: 'old-1', type: 'meeting.delete', entityId: MEETING, details: {}, occurredAt: new Date().toISOString() });
    c.startAuditReporting('user-1');
    await vi.advanceTimersByTimeAsync(1500);
    expect(sentBodies()[0][0].clientEventId).toBe('old-1');
    expect(h.queue).toHaveLength(0);
  });

  it('never posts one user\'s queue under the next user\'s session: it waits for the owner\'s next login', async () => {
    const scope = await import('@/lib/storage/scope');
    c.reportAuditEvent('meeting.minutes_save', MEETING);
    c.reportAuditEvent('meeting.delete', OTHER);
    // user-1 signs out and user-2 signs in while the coalesced event is still held.
    scope.setStorageUserId('user-2');
    await vi.advanceTimersByTimeAsync(c.COALESCE_WINDOW_MS + 5000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.queue.map((e) => e.type).sort()).toEqual(['meeting.delete', 'meeting.minutes_save']);
    await c.flush('user-1');
    expect(fetchMock).not.toHaveBeenCalled();

    scope.setStorageUserId('user-1');
    c.startAuditReporting('user-1');
    await vi.advanceTimersByTimeAsync(1500);
    expect(sentBodies().flat().map((e) => e.type).sort()).toEqual(['meeting.delete', 'meeting.minutes_save']);
    expect(h.queue).toHaveLength(0);
  });

  it('stops draining mid-flush when the signed-in user changes', async () => {
    const scope = await import('@/lib/storage/scope');
    for (let i = 0; i < 120; i++) {
      h.queue.push({ clientEventId: `e-${i}`, type: 'meeting.delete', entityId: MEETING, details: {}, occurredAt: new Date().toISOString() });
    }
    fetchMock.mockImplementation(async () => {
      scope.setStorageUserId('user-2');
      return respond(200);
    });
    await c.flush('user-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.queue).toHaveLength(70);
  });

  it('sends at most 50 events per request and keeps draining', async () => {
    for (let i = 0; i < 120; i++) {
      h.queue.push({ clientEventId: `e-${i}`, type: 'meeting.delete', entityId: MEETING, details: {}, occurredAt: new Date().toISOString() });
    }
    c.startAuditReporting('user-1');
    await vi.advanceTimersByTimeAsync(1500);
    expect(sentBodies().map((b) => b.length)).toEqual([50, 50, 20]);
  });

  describe('coalescing', () => {
    it('sends one event per meeting+type per 30 s window carrying the last details', async () => {
      c.reportAuditEvent('meeting.participants_edit', MEETING, { participantCount: 1 });
      await vi.advanceTimersByTimeAsync(10_000);
      c.reportAuditEvent('meeting.participants_edit', MEETING, { participantCount: 2 });
      c.reportAuditEvent('meeting.participants_edit', MEETING, { participantCount: 5 });
      expect(h.queue).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.queue).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(sentBodies().flat()).toHaveLength(1);
      expect(sentBodies().flat()[0]).toMatchObject({ type: 'meeting.participants_edit', details: { participantCount: 5 } });
    });

    it('coalesces minutes_save and transcript_edit independently per meeting', async () => {
      for (let i = 0; i < 5; i++) {
        c.reportAuditEvent('meeting.minutes_save', MEETING);
        c.reportAuditEvent('meeting.minutes_save', OTHER);
        c.reportAuditEvent('meeting.transcript_edit', MEETING, { segmentCount: i });
      }
      await vi.advanceTimersByTimeAsync(31_000 + 1500);
      const sent = sentBodies().flat();
      expect(sent).toHaveLength(3);
      expect(sent.find((e) => e.type === 'meeting.transcript_edit')?.details).toEqual({ segmentCount: 4 });
    });

    it('coalesces renames: typing a title with pauses sends one rename per meeting per window', async () => {
      for (let i = 0; i < 4; i++) {
        c.reportAuditEvent('meeting.rename', MEETING);
        await vi.advanceTimersByTimeAsync(2_000);
      }
      c.reportAuditEvent('meeting.rename', OTHER);
      await vi.advanceTimersByTimeAsync(31_000 + 1500);
      const sent = sentBodies().flat();
      expect(sent.map((e) => [e.type, e.entityId]).sort()).toEqual([['meeting.rename', MEETING], ['meeting.rename', OTHER]].sort());
    });

    it('starts a new window after the previous one ended', async () => {
      c.reportAuditEvent('meeting.minutes_save', MEETING);
      await vi.advanceTimersByTimeAsync(31_000);
      c.reportAuditEvent('meeting.minutes_save', MEETING);
      await vi.advanceTimersByTimeAsync(31_000 + 1500);
      expect(sentBodies().flat()).toHaveLength(2);
    });

    it('writes held events out immediately when the page is hidden or closed', async () => {
      c.reportAuditEvent('meeting.participants_edit', MEETING, { participantCount: 3 });
      window.dispatchEvent(new Event('pagehide'));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sentBodies()[0][0].details).toEqual({ participantCount: 3 });
      // Nothing left to send when the window would have ended.
      await vi.advanceTimersByTimeAsync(40_000);
      expect(sentBodies().flat()).toHaveLength(1);
    });

    it('never coalesces state changes: every delete is its own event', async () => {
      c.reportAuditEvent('meeting.delete', MEETING);
      c.reportAuditEvent('meeting.delete', OTHER);
      await vi.advanceTimersByTimeAsync(1500);
      expect(sentBodies().flat()).toHaveLength(2);
    });
  });

  it('reports one audio_delete per meeting inside the dedupe window (deleteAudio + updateMeeting for one action)', async () => {
    c.reportAuditEvent('meeting.audio_delete', MEETING);
    c.reportAuditEvent('meeting.audio_delete', MEETING);
    c.reportAuditEvent('meeting.audio_delete', OTHER);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sentBodies().flat().map((e) => e.entityId).sort()).toEqual([MEETING, OTHER].sort());
    await vi.advanceTimersByTimeAsync(61_000);
    c.reportAuditEvent('meeting.audio_delete', MEETING);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sentBodies().flat()).toHaveLength(3);
  });

  it('never throws and never blocks when the outbox fails', async () => {
    h.addFails = true;
    expect(() => c.reportAuditEvent('meeting.delete', MEETING)).not.toThrow();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing without IndexedDB or without a known user', async () => {
    h.available = false;
    c.reportAuditEvent('meeting.delete', MEETING);
    c.startAuditReporting('user-1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.queue).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    h.available = true;
    await load(null);
    c.reportAuditEvent('meeting.delete', MEETING);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.queue).toHaveLength(0);
  });
});

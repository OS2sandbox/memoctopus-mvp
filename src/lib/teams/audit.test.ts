import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordEvent: vi.fn().mockResolvedValue({ status: 'stored' }),
  recordServerEvent: vi.fn().mockResolvedValue({ status: 'stored' }),
}));

import { recordEvent, recordServerEvent, validateEvent } from '@/lib/audit/record';
import type { AuditEventInput } from '@/lib/audit/events';
import {
  recordTeamsArtifactsFetch,
  recordTeamsRecordingDelete,
  recordTeamsRegister,
  recordTeamsStashDelete,
  recordTeamsUnregister,
} from './audit';

const mockEvent = vi.mocked(recordEvent);
const mockServerEvent = vi.mocked(recordServerEvent);

const MEETING = '11111111-2222-4333-8444-555555555555';
const REQ = { headers: new Headers({ 'user-agent': 'test' }) };

/** The single event the last call wrote, which must also pass the real catalogue validation. */
function sent(mock: typeof mockEvent | typeof mockServerEvent): Record<string, unknown> {
  const call = mock.mock.calls.at(-1)!;
  const event = (mock === mockServerEvent ? call[1] : call[0]) as Record<string, unknown>;
  expect(validateEvent(event as unknown as AuditEventInput)).toMatchObject({ ok: true });
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEvent.mockResolvedValue({ status: 'stored' });
  mockServerEvent.mockResolvedValue({ status: 'stored' });
});

describe('teams.meeting_register', () => {
  it('records the arm verdict as a server event of the person, with the request attached', async () => {
    await recordTeamsRegister(REQ, { userId: 'u1', meetingId: MEETING, outcome: 'success', armed: true, isOrganizer: true, armResult: 'armed' });

    expect(mockServerEvent.mock.calls.at(-1)![0]).toBe(REQ);
    expect(sent(mockServerEvent)).toEqual({
      type: 'teams.meeting_register',
      actorUserId: 'u1',
      outcome: 'success',
      entityId: MEETING,
      details: { armed: true, isOrganizer: true, armResult: 'armed' },
    });
  });

  it('a failure carries a code and only what was known; a meeting id that is not a UUID is no entity', async () => {
    await recordTeamsRegister(REQ, { userId: 'u1', meetingId: 'meeting-1', outcome: 'error', code: 'unavailable' });

    expect(sent(mockServerEvent)).toEqual({
      type: 'teams.meeting_register',
      actorUserId: 'u1',
      outcome: 'error',
      details: { code: 'unavailable' },
    });
  });
});

describe('teams.meeting_unregister', () => {
  it('success when the options are back, an error with the code when they could not be put back', async () => {
    await recordTeamsUnregister(REQ, { userId: 'u1', meetingId: MEETING, disarmed: true });
    expect(sent(mockServerEvent)).toMatchObject({ type: 'teams.meeting_unregister', outcome: 'success', details: { disarmed: true } });

    await recordTeamsUnregister(REQ, { userId: 'u1', meetingId: MEETING, disarmed: false, code: 'forbidden' });
    expect(sent(mockServerEvent)).toMatchObject({ outcome: 'error', details: { disarmed: false, code: 'forbidden' } });
  });
});

describe('teams.artifacts_fetch', () => {
  it('the poller is the system acting for the owner; a person pressing the button is the server', async () => {
    await recordTeamsArtifactsFetch({ userId: 'u1', meetingId: MEETING, trigger: 'poller', result: 'ready', transcript: true, recording: true });
    expect(sent(mockEvent)).toEqual({
      type: 'teams.artifacts_fetch',
      source: 'system',
      actorUserId: 'u1',
      outcome: 'success',
      entityId: MEETING,
      details: { trigger: 'poller', result: 'ready', transcript: true, recording: true },
    });

    await recordTeamsArtifactsFetch({ userId: 'u1', meetingId: MEETING, trigger: 'manual', result: 'failed', transcript: false, recording: false, code: 'http_502' });
    expect(sent(mockEvent)).toMatchObject({ source: 'server', outcome: 'error', details: { trigger: 'manual', result: 'failed', code: 'http_502' } });
  });
});

describe('teams.recording_delete', () => {
  it('is a system event; only a failed delete is an error', async () => {
    await recordTeamsRecordingDelete({ userId: 'u1', meetingId: MEETING, status: 'recycled' });
    expect(sent(mockEvent)).toEqual({
      type: 'teams.recording_delete',
      source: 'system',
      actorUserId: 'u1',
      outcome: 'success',
      entityId: MEETING,
      details: { status: 'recycled' },
    });

    await recordTeamsRecordingDelete({ userId: 'u1', meetingId: MEETING, status: 'failed' });
    expect(sent(mockEvent)).toMatchObject({ outcome: 'error', details: { status: 'failed' } });
  });
});

describe('teams.stash_delete', () => {
  it('a hand-off is the server acting for the person; the sweep is the system, with the owner when known', async () => {
    await recordTeamsStashDelete({ trigger: 'handoff', meetingId: MEETING, userId: 'u1' });
    expect(sent(mockEvent)).toEqual({ type: 'teams.stash_delete', source: 'server', actorUserId: 'u1', entityId: MEETING, details: { trigger: 'handoff' } });

    await recordTeamsStashDelete({ trigger: 'ttl', meetingId: MEETING, userId: null });
    expect(sent(mockEvent)).toEqual({ type: 'teams.stash_delete', source: 'system', entityId: MEETING, details: { trigger: 'ttl' } });

    await recordTeamsStashDelete({ trigger: 'ttl', meetingId: 'not-a-uuid', userId: 'u1', failed: true });
    expect(sent(mockEvent)).toEqual({ type: 'teams.stash_delete', source: 'system', actorUserId: 'u1', outcome: 'error', details: { trigger: 'ttl' } });
  });
});

describe('never breaks the flow', () => {
  it('swallows a rejecting audit write and a throwing one', async () => {
    mockEvent.mockRejectedValue(new Error('db down'));
    mockServerEvent.mockImplementation(() => {
      throw new Error('headers unreadable');
    });
    await expect(recordTeamsStashDelete({ trigger: 'ttl', meetingId: MEETING })).resolves.toBeUndefined();
    await expect(recordTeamsRecordingDelete({ userId: 'u1', meetingId: MEETING, status: 'deleted' })).resolves.toBeUndefined();
    await expect(recordTeamsUnregister(REQ, { userId: 'u1', meetingId: MEETING, disarmed: true })).resolves.toBeUndefined();
  });

  it('does not hold the caller up for a slow audit write', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockEvent.mockReturnValue(new Promise(() => {}));
      let done = false;
      const p = recordTeamsStashDelete({ trigger: 'ttl', meetingId: MEETING }).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(2_100);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

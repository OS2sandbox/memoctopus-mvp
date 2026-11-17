import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/teams/graph-client', () => ({
  graphJson: vi.fn(),
  graphFetch: vi.fn(),
  GraphError: class GraphError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, options: { status?: number } = {}) {
      super(message);
      this.name = 'GraphError';
      this.code = code;
      this.status = options.status ?? 0;
    }
  },
}));

import { graphFetch, graphJson, GraphError } from '@/lib/teams/graph-client';
import {
  armMeeting,
  disarmMeeting,
  isArmed,
  isInstantMeeting,
  isLateArm,
  ARM_OPTIONS,
  LATE_ARM_LEAD_MS,
} from './meeting-arm';

const mockFetch = vi.mocked(graphFetch);
const mockJson = vi.mocked(graphJson);
const USER = 'user-1';
const ID = 'GRAPH-1';

/** A scheduled meeting: a real, non-empty window, so arming is `armed`. */
const SCHEDULED = {
  startDateTime: '2026-09-23T09:00:00Z',
  endDateTime: '2026-09-23T09:30:00Z',
};

/** What Graph reports when we read the meeting back after the PATCH. */
function readBack(options: Record<string, unknown>) {
  mockJson.mockImplementation(async (_user: string, path: string) => {
    if (path.startsWith('/me?')) return { id: 'me-oid' } as never;
    return {
      id: ID,
      participants: { organizer: { identity: { user: { id: 'me-oid' } } } },
      ...SCHEDULED,
      ...options,
    } as never;
  });
}

const ARMED = {
  allowRecording: true,
  allowTranscription: true,
  recordAutomatically: true,
  meetingSpokenLanguageTag: 'da-DK',
};

/** An hour before SCHEDULED starts: comfortably early, so arming is plain `armed`. */
const EARLY = new Date('2026-09-23T08:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EARLY);
  mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
  readBack(ARMED);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.TEAMS_SPOKEN_LANGUAGE;
});

function patchCall() {
  const call = mockFetch.mock.calls[0];
  return { path: call[1] as string, init: call[2] as RequestInit };
}

describe('armMeeting', () => {
  it('PATCHes the four meeting options as JSON', async () => {
    const outcome = await armMeeting(USER, ID);

    expect(outcome).toMatchObject({ result: 'armed', options: ARMED });
    const { path, init } = patchCall();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(path).toBe('/me/onlineMeetings/GRAPH-1');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      allowRecording: true,
      allowTranscription: true,
      recordAutomatically: true,
      meetingSpokenLanguageTag: 'da-DK',
    });
  });

  it('exposes the defaults as ARM_OPTIONS', () => {
    expect(ARM_OPTIONS).toEqual({
      allowRecording: true,
      allowTranscription: true,
      recordAutomatically: true,
      meetingSpokenLanguageTag: 'da-DK',
    });
  });

  it('honours TEAMS_SPOKEN_LANGUAGE', async () => {
    process.env.TEAMS_SPOKEN_LANGUAGE = 'en-GB';
    readBack({ ...ARMED, meetingSpokenLanguageTag: 'en-GB' });

    await armMeeting(USER, ID);

    expect(JSON.parse(patchCall().init.body as string).meetingSpokenLanguageTag).toBe('en-GB');
  });

  it('falls back to da-DK when the env var is blank', async () => {
    process.env.TEAMS_SPOKEN_LANGUAGE = '   ';
    await armMeeting(USER, ID);
    expect(JSON.parse(patchCall().init.body as string).meetingSpokenLanguageTag).toBe('da-DK');
  });

  it('percent-encodes the meeting id', async () => {
    await armMeeting(USER, 'MSo0#/2');
    expect(patchCall().path).toBe('/me/onlineMeetings/MSo0%23%2F2');
  });

  it('is idempotent — arming twice sends the same body', async () => {
    await armMeeting(USER, ID);
    const first = patchCall().init.body;
    mockFetch.mockClear();
    const second = await armMeeting(USER, ID);
    expect(patchCall().init.body).toBe(first);
    expect(second.result).toBe('armed');
  });

  it('reports not_organizer on a 403 and does not read back a second time', async () => {
    mockFetch.mockRejectedValue(new GraphError('forbidden', 'Ingen adgang', { status: 403 }));
    readBack({ ...ARMED, recordAutomatically: false });

    const outcome = await armMeeting(USER, ID);

    expect(outcome.result).toBe('not_organizer');
    expect(outcome.options.recordAutomatically).toBe(false);
  });

  it('reports not_organizer with unknown options when the read-back also fails', async () => {
    mockFetch.mockRejectedValue(new GraphError('forbidden', 'Ingen adgang', { status: 403 }));
    mockJson.mockRejectedValue(new GraphError('forbidden', 'Ingen adgang', { status: 403 }));

    const outcome = await armMeeting(USER, ID);

    expect(outcome).toMatchObject({
      result: 'not_organizer',
      options: {
        allowRecording: null,
        allowTranscription: null,
        recordAutomatically: null,
        meetingSpokenLanguageTag: null,
      },
    });
  });

  it('rethrows errors that are not a 403', async () => {
    mockFetch.mockRejectedValue(new GraphError('reauth_required', 'Log ind igen', { status: 401 }));
    await expect(armMeeting(USER, ID)).rejects.toMatchObject({ code: 'reauth_required' });
  });

  it('reports policy_blocked when recordAutomatically comes back false', async () => {
    readBack({ ...ARMED, recordAutomatically: false });
    const outcome = await armMeeting(USER, ID);
    expect(outcome.result).toBe('policy_blocked');
    expect(outcome.options.recordAutomatically).toBe(false);
  });

  it('reports policy_blocked when allowTranscription comes back false', async () => {
    readBack({ ...ARMED, allowTranscription: false });
    await expect(armMeeting(USER, ID)).resolves.toMatchObject({ result: 'policy_blocked' });
  });

  it('does not treat a missing (null) flag as policy_blocked', async () => {
    readBack({ allowRecording: true, allowTranscription: true });
    await expect(armMeeting(USER, ID)).resolves.toMatchObject({ result: 'armed' });
  });
});

describe('armMeeting — snapshot of the original options', () => {
  const ORIGINAL = {
    allowRecording: false,
    allowTranscription: false,
    recordAutomatically: false,
    meetingSpokenLanguageTag: 'en-GB',
  };

  /** Graph answers with `first` until the PATCH has gone out, then with `after`. */
  function stateChangesOnPatch(first: Record<string, unknown>, after: Record<string, unknown>) {
    let patched = false;
    mockFetch.mockImplementation(async () => {
      patched = true;
      return new Response(null, { status: 200 });
    });
    mockJson.mockImplementation(async (_user: string, path: string) => {
      if (path.startsWith('/me?')) return { id: 'me-oid' } as never;
      return {
        id: ID,
        participants: { organizer: { identity: { user: { id: 'me-oid' } } } },
        ...(patched ? after : first),
      } as never;
    });
  }

  it('returns the options as they were BEFORE the PATCH', async () => {
    stateChangesOnPatch(ORIGINAL, ARMED);

    const outcome = await armMeeting(USER, ID);

    expect(outcome.previousOptions).toEqual(ORIGINAL);
    expect(outcome.options).toEqual(ARMED);
  });

  it('reads the meeting before it sends the PATCH', async () => {
    stateChangesOnPatch(ORIGINAL, ARMED);

    await armMeeting(USER, ID);

    const firstRead = mockJson.mock.invocationCallOrder[0];
    const patch = mockFetch.mock.invocationCallOrder[0];
    expect(firstRead).toBeLessThan(patch);
  });

  it('reports nothing readable when the pre-read fails, and still arms', async () => {
    let patched = false;
    mockFetch.mockImplementation(async () => {
      patched = true;
      return new Response(null, { status: 200 });
    });
    mockJson.mockImplementation(async (_user: string, path: string) => {
      if (!patched) throw new GraphError('http', 'Graph-fejl', { status: 500 });
      if (path.startsWith('/me?')) return { id: 'me-oid' } as never;
      return { id: ID, ...SCHEDULED, ...ARMED } as never;
    });

    const outcome = await armMeeting(USER, ID);

    expect(outcome.result).toBe('armed');
    expect(outcome.previousOptions).toEqual({
      allowRecording: null,
      allowTranscription: null,
      recordAutomatically: null,
      meetingSpokenLanguageTag: null,
    });
  });
});

describe('disarmMeeting', () => {
  const ORIGINAL = {
    allowRecording: false,
    allowTranscription: false,
    recordAutomatically: false,
    meetingSpokenLanguageTag: 'en-GB',
  };

  it('restores every original value exactly, including the ones that were off', async () => {
    await disarmMeeting(USER, ID, ORIGINAL);

    const { path, init } = patchCall();
    expect(path).toBe('/me/onlineMeetings/GRAPH-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual(ORIGINAL);
  });

  it('restores originals that were on as on', async () => {
    const before = { ...ORIGINAL, allowRecording: true, meetingSpokenLanguageTag: 'da-DK' };
    await disarmMeeting(USER, ID, before);
    expect(JSON.parse(patchCall().init.body as string)).toEqual(before);
  });

  it('leaves unreadable (null) values alone', async () => {
    await disarmMeeting(USER, ID, {
      allowRecording: true,
      allowTranscription: null,
      recordAutomatically: false,
      meetingSpokenLanguageTag: null,
    });

    expect(JSON.parse(patchCall().init.body as string)).toEqual({
      allowRecording: true,
      recordAutomatically: false,
    });
  });

  it('falls back to resetting recordAutomatically for a row armed before snapshots existed', async () => {
    await disarmMeeting(USER, ID, null);
    expect(JSON.parse(patchCall().init.body as string)).toEqual({ recordAutomatically: false });
  });

  it('falls back the same way when nothing in the snapshot was readable', async () => {
    await disarmMeeting(USER, ID, {
      allowRecording: null,
      allowTranscription: null,
      recordAutomatically: null,
      meetingSpokenLanguageTag: null,
    });
    expect(JSON.parse(patchCall().init.body as string)).toEqual({ recordAutomatically: false });
  });

  it('does not read the meeting back', async () => {
    await disarmMeeting(USER, ID, ORIGINAL);
    expect(mockJson).not.toHaveBeenCalled();
  });

  it('is harmless twice: the same PATCH is sent both times', async () => {
    await disarmMeeting(USER, ID, ORIGINAL);
    const first = patchCall().init.body;
    mockFetch.mockClear();
    await expect(disarmMeeting(USER, ID, ORIGINAL)).resolves.toBeUndefined();
    expect(patchCall().init.body).toBe(first);
  });

  it('swallows a 403 from a non-organizer', async () => {
    mockFetch.mockRejectedValue(new GraphError('forbidden', 'Ingen adgang', { status: 403 }));
    await expect(disarmMeeting(USER, ID, ORIGINAL)).resolves.toBeUndefined();
  });

  it('rethrows other Graph errors', async () => {
    mockFetch.mockRejectedValue(new GraphError('not_found', 'Findes ikke', { status: 404 }));
    await expect(disarmMeeting(USER, ID, ORIGINAL)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('armMeeting on a meeting that is already under way', () => {
  it('reports armed_in_progress for an instant meeting Graph gives no window', async () => {
    // "Mød nu": Graph answers the year-1 sentinel, which graphDate makes null.
    readBack({ ...ARMED, startDateTime: '0001-01-01T00:00:00Z', endDateTime: '0001-01-01T00:00:00Z' });

    const outcome = await armMeeting(USER, ID);

    expect(outcome.result).toBe('armed_in_progress');
    expect(isArmed(outcome.result)).toBe(true);
  });

  it('reports armed_in_progress for a zero-length window', async () => {
    // What Graph actually returned for a real "Mød nu" meeting: start == end ==
    // the moment it was created.
    readBack({ ...ARMED, startDateTime: '2026-09-23T09:11:21Z', endDateTime: '2026-09-23T09:11:21Z' });

    expect((await armMeeting(USER, ID)).result).toBe('armed_in_progress');
  });

  it('still PATCHes allowTranscription, so it can be started by hand', async () => {
    readBack({ ...ARMED, startDateTime: '2026-09-23T09:11:21Z', endDateTime: '2026-09-23T09:11:21Z' });

    await armMeeting(USER, ID);

    expect(JSON.parse(patchCall().init.body as string)).toMatchObject({ allowTranscription: true });
  });

  it('reports armed for a scheduled meeting switched on well before its start', async () => {
    readBack({ ...ARMED, ...SCHEDULED });

    expect((await armMeeting(USER, ID, EARLY)).result).toBe('armed');
  });

  it('reports armed_late for a scheduled meeting switched on after its start', async () => {
    // People may be in it already, and a running meeting ignores
    // recordAutomatically: the user has to be told to start it by hand.
    readBack({ ...ARMED, ...SCHEDULED });

    const outcome = await armMeeting(USER, ID, new Date('2026-09-23T09:05:00Z'));

    expect(outcome.result).toBe('armed_late');
    expect(isArmed(outcome.result)).toBe(true);
  });

  it('reports armed_late just before the start too, when people may have joined early', async () => {
    readBack({ ...ARMED, ...SCHEDULED });

    expect((await armMeeting(USER, ID, new Date('2026-09-23T08:50:00Z'))).result).toBe('armed_late');
  });

  it('still PATCHes recordAutomatically on a late arm: the organizer may just be running late', async () => {
    readBack({ ...ARMED, ...SCHEDULED });

    await armMeeting(USER, ID, new Date('2026-09-23T09:05:00Z'));

    expect(JSON.parse(patchCall().init.body as string)).toMatchObject({ recordAutomatically: true });
  });

  it('lets a blocking policy win over a late arm', async () => {
    readBack({ ...ARMED, ...SCHEDULED, recordAutomatically: false });

    expect((await armMeeting(USER, ID, new Date('2026-09-23T09:05:00Z'))).result).toBe('policy_blocked');
  });

  it('keeps armed_in_progress for an instant meeting however late it is armed', async () => {
    readBack({ ...ARMED, startDateTime: '2026-09-23T09:11:21Z', endDateTime: '2026-09-23T09:11:21Z' });

    expect((await armMeeting(USER, ID, new Date('2026-09-23T10:00:00Z'))).result).toBe('armed_in_progress');
  });

  it('lets a blocking policy win over an instant meeting', async () => {
    readBack({
      ...ARMED,
      allowTranscription: false,
      startDateTime: '2026-09-23T09:11:21Z',
      endDateTime: '2026-09-23T09:11:21Z',
    });

    expect((await armMeeting(USER, ID)).result).toBe('policy_blocked');
  });
});

describe('isInstantMeeting', () => {
  it('is true without a start, false for a real window', () => {
    expect(isInstantMeeting(null, null)).toBe(true);
    expect(isInstantMeeting('2026-09-23T09:00:00Z', '2026-09-23T09:30:00Z')).toBe(false);
  });

  it('does not guess when only the end is missing', () => {
    expect(isInstantMeeting('2026-09-23T09:00:00Z', null)).toBe(false);
  });
});

describe('isLateArm', () => {
  const START = '2026-09-23T09:00:00Z';

  it('is false until the lead before the start', () => {
    expect(isLateArm(START, new Date(Date.parse(START) - LATE_ARM_LEAD_MS - 1))).toBe(false);
  });

  it('is true from the lead before the start onwards', () => {
    expect(isLateArm(START, new Date(Date.parse(START) - LATE_ARM_LEAD_MS))).toBe(true);
    expect(isLateArm(START, new Date('2026-09-23T12:00:00Z'))).toBe(true);
  });

  it('is false without a usable start', () => {
    expect(isLateArm(null, new Date())).toBe(false);
    expect(isLateArm('not a date', new Date())).toBe(false);
  });
});

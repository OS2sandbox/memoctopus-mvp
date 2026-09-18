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
import { armMeeting, disarmMeeting, ARM_OPTIONS } from './meeting-arm';

const mockFetch = vi.mocked(graphFetch);
const mockJson = vi.mocked(graphJson);
const USER = 'user-1';
const ID = 'GRAPH-1';

/** What Graph reports when we read the meeting back after the PATCH. */
function readBack(options: Record<string, unknown>) {
  mockJson.mockImplementation(async (_user: string, path: string) => {
    if (path.startsWith('/me?')) return { id: 'me-oid' } as never;
    return {
      id: ID,
      participants: { organizer: { identity: { user: { id: 'me-oid' } } } },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
  readBack(ARMED);
});

afterEach(() => {
  delete process.env.TEAMS_SPOKEN_LANGUAGE;
});

function patchCall() {
  const call = mockFetch.mock.calls[0];
  return { path: call[1] as string, init: call[2] as RequestInit };
}

describe('armMeeting', () => {
  it('PATCHes the four meeting options as JSON', async () => {
    const outcome = await armMeeting(USER, ID);

    expect(outcome).toEqual({ result: 'armed', options: ARMED });
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

    expect(outcome).toEqual({
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

describe('disarmMeeting', () => {
  it('PATCHes only recordAutomatically:false', async () => {
    await disarmMeeting(USER, ID);
    const { path, init } = patchCall();
    expect(path).toBe('/me/onlineMeetings/GRAPH-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ recordAutomatically: false });
  });

  it('does not read the meeting back', async () => {
    await disarmMeeting(USER, ID);
    expect(mockJson).not.toHaveBeenCalled();
  });

  it('swallows a 403 from a non-organizer', async () => {
    mockFetch.mockRejectedValue(new GraphError('forbidden', 'Ingen adgang', { status: 403 }));
    await expect(disarmMeeting(USER, ID)).resolves.toBeUndefined();
  });

  it('rethrows other Graph errors', async () => {
    mockFetch.mockRejectedValue(new GraphError('not_found', 'Findes ikke', { status: 404 }));
    await expect(disarmMeeting(USER, ID)).rejects.toMatchObject({ code: 'not_found' });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ pool: {}, db: {} }));
vi.mock('@/lib/auth', () => ({ auth: { api: {} } }));
vi.mock('@/lib/outlook/addin-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/outlook/addin-auth')>()),
  authenticateAddinRequest: vi.fn(),
}));
vi.mock('@/lib/outlook/arm-from-outlook', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/outlook/arm-from-outlook')>()),
  armFromOutlook: vi.fn(),
}));
vi.mock('@/lib/teams/create-meeting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/teams/create-meeting')>()),
  createOnlineMeeting: vi.fn(),
}));
vi.mock('@/lib/teams/meeting-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/teams/meeting-resolver')>()),
  getMeeting: vi.fn(),
}));

import { POST } from './route';
import { AddinAuthError, authenticateAddinRequest } from '@/lib/outlook/addin-auth';
import { armFromOutlook } from '@/lib/outlook/arm-from-outlook';
import { createOnlineMeeting, meetingSubject } from '@/lib/teams/create-meeting';
import { GraphError } from '@/lib/teams/graph-client';
import { getMeeting } from '@/lib/teams/meeting-resolver';

const mockAuth = vi.mocked(authenticateAddinRequest);
const mockArm = vi.mocked(armFromOutlook);
const mockCreate = vi.mocked(createOnlineMeeting);
const mockGet = vi.mocked(getMeeting);

const JOIN = 'https://teams.microsoft.com/meet/123456789?p=abc';
const START = '2026-11-03T09:00:00.000Z';
const END = '2026-11-03T09:30:00.000Z';

function req(body: unknown) {
  return new Request('https://x/api/outlook/online-meetings', {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockAuth.mockResolvedValue('user-1');
  mockCreate.mockResolvedValue({ graphMeetingId: 'graph-1', joinUrl: JOIN, meetingCode: '123 456 789', passcode: 'pw' });
  mockGet.mockResolvedValue({
    graphMeetingId: 'graph-1', joinUrl: JOIN, subject: 'Møde', organizerId: 'me', isOrganizer: true,
    scheduledStart: START, scheduledEnd: END, meetingType: null,
    options: { allowRecording: null, allowTranscription: null, recordAutomatically: null, meetingSpokenLanguageTag: null },
  });
  mockArm.mockResolvedValue({
    id: 'ol-1', subject: 'Møde', scheduledStart: START, scheduledEnd: END, isOrganizer: true,
    armed: true, armResult: 'armed', alreadyRegistered: false, managedInDashboard: false,
  });
});

describe('POST /api/outlook/online-meetings', () => {
  it('creates a meeting for the appointment, arms it, and returns what goes in the invitation', async () => {
    const res = await POST(req({ subject: 'Møde', start: START, end: END }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: 'ol-1', armResult: 'armed', joinUrl: JOIN, meetingCode: '123 456 789', passcode: 'pw' });
    expect(mockCreate).toHaveBeenCalledWith('user-1', { subject: 'Møde', start: new Date(START), end: new Date(END) });
    expect(mockGet).toHaveBeenCalledWith('user-1', 'graph-1');
    expect(mockArm.mock.calls[0][1]).toMatchObject({ joinUrl: JOIN, occurrenceStart: new Date(START), occurrenceEnd: new Date(END) });
  });

  it('refuses without a valid add-in token (or for a user not on the list), before touching Graph', async () => {
    mockAuth.mockRejectedValue(new AddinAuthError('not_allowed'));
    const res = await POST(req({ subject: 'Møde', start: START, end: END }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('not_allowed');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses an appointment without a window, before touching Graph', async () => {
    for (const body of [{}, { start: START }, { start: END, end: START }, { start: 'x', end: END }]) {
      expect((await POST(req(body))).status).toBe(400);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('passes Graph errors on with their Danish message', async () => {
    mockCreate.mockRejectedValue(new GraphError('reauth_required', 'Log ind med Microsoft igen.'));
    const res = await POST(req({ subject: 'Møde', start: START, end: END }));
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe('Log ind med Microsoft igen.');
  });
});

describe('meetingSubject', () => {
  it('collapses whitespace, defaults a blank subject, and caps the length', () => {
    expect(meetingSubject('  Team\n møde ')).toBe('Team møde');
    expect(meetingSubject('   ')).toBe('Teams-møde');
    expect(meetingSubject('x'.repeat(400))).toHaveLength(255);
  });
});

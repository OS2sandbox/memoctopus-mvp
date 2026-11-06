// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  armMeeting: vi.fn(),
  disarmMeeting: vi.fn(),
}));
vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  loadConfig: vi.fn(),
  getBearerToken: vi.fn(),
}));

import { ApiError, armMeeting, disarmMeeting, type ArmResponse } from './api';
import { getBearerToken, loadConfig } from './auth';
import type { AsyncResult, CustomProperties, OfficeApi, OrganizerItem } from './office';
import { arm, disarm, start, type State } from './pane';

const CLIENT = '33333333-3333-3333-3333-333333333333';
const TENANT = '11111111-1111-1111-1111-111111111111';
const JOIN = 'https://teams.microsoft.com/meet/399000000000001?p=FaKeFaKeFaKe0001';
const START = new Date('2026-11-03T09:00:00.000Z');
const END = new Date('2026-11-03T10:00:00.000Z');

/** The pane's markup, from the real taskpane.html, so a missing id fails here. */
const html = readFileSync(path.join(__dirname, 'taskpane.html'), 'utf8');
const main = /<main>[\s\S]*<\/main>/.exec(html)![0];

const text = (id: string) => document.getElementById(id)!.textContent ?? '';
const visible = (id: string) => !document.getElementById(id)!.hidden;

/**
 * An appointment in Outlook's organizer form, with working custom properties.
 * `series`: a recurring series itself, or one of its occurrences; `legacy` is an
 * Outlook without Mailbox 1.7, where neither can be read.
 */
function fakeOutlook({
  body = `<a href="${JOIN}">Deltag</a>`,
  props: initial = {} as Record<string, unknown>,
  series = 'none' as 'none' | 'series' | 'occurrence' | 'legacy',
} = {}) {
  const store: Record<string, unknown> = { ...initial };
  const ok = <T>(value: T): AsyncResult<T> => ({ status: 'succeeded', value });
  const props: CustomProperties = {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    remove: (k) => { delete store[k]; },
    saveAsync: (cb) => cb(ok(undefined)),
  };
  const item = {
    start: { getAsync: (cb: (r: AsyncResult<Date>) => void) => cb(ok(START)) },
    end: { getAsync: (cb: (r: AsyncResult<Date>) => void) => cb(ok(END)) },
    body: { getAsync: (_coercion: string, cb: (r: AsyncResult<string>) => void) => cb(ok(body)) },
    loadCustomPropertiesAsync: (cb: (r: AsyncResult<CustomProperties>) => void) => cb(ok(props)),
    ...(series === 'legacy'
      ? {}
      : {
          seriesId: series === 'occurrence' ? 'AAMkSERIES' : null,
          recurrence: {
            getAsync: (cb: (r: AsyncResult<unknown>) => void) =>
              cb(ok(series === 'none' ? null : { recurrenceType: 'weekly' })),
          },
        }),
  } as unknown as OrganizerItem;
  const office = {
    onReady: async () => ({ host: 'Outlook', platform: 'OfficeOnline' }),
    CoercionType: { Html: 'html', Text: 'text' },
    AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
    context: { mailbox: { item }, requirements: { isSetSupported: () => true } },
  } as unknown as OfficeApi;
  return { office, item, store };
}

const CONFIG = { clientId: CLIENT, tenantId: TENANT, scopes: [`api://${CLIENT}/access_as_user`], token: 'api' as const, deletesRecording: true };

function armResponse(overrides: Partial<ArmResponse> = {}): ArmResponse {
  return {
    id: 'ol-1',
    subject: 'Styregruppe',
    scheduledStart: START.toISOString(),
    scheduledEnd: END.toISOString(),
    isOrganizer: true,
    armed: true,
    armResult: 'armed',
    alreadyRegistered: false,
    managedInDashboard: false,
    ...overrides,
  };
}

function stateFor(o: ReturnType<typeof fakeOutlook>, overrides: Partial<State> = {}): State {
  return { office: o.office, item: o.item, joinUrl: JOIN, armedId: null, config: null, ...overrides };
}

beforeEach(() => {
  document.body.innerHTML = main;
  vi.mocked(loadConfig).mockResolvedValue(CONFIG);
  vi.mocked(getBearerToken).mockResolvedValue('token');
});

afterEach(() => {
  vi.clearAllMocks();
  delete (globalThis as { Office?: unknown }).Office;
});

describe('arm', () => {
  it('switches the meeting on with its link and times, and notes it on the appointment', async () => {
    const o = fakeOutlook();
    vi.mocked(armMeeting).mockResolvedValue(armResponse());
    const state = stateFor(o);

    await arm(state);

    expect(armMeeting).toHaveBeenCalledWith(JOIN, { start: START, end: END }, 'token');
    expect(state.armedId).toBe('ol-1');
    expect(text('status')).toMatch(/optaget og transskriberet/);
    expect(visible('disarm')).toBe(true);
    expect(visible('arm')).toBe(false);
    expect(Object.keys(o.store)).not.toHaveLength(0);
  });

  it('leaves a meeting registered in the dashboard to the dashboard: no note, no "Slå fra"', async () => {
    const o = fakeOutlook();
    vi.mocked(armMeeting).mockResolvedValue(armResponse({ id: 'd-1', managedInDashboard: true, alreadyRegistered: true }));
    const state = stateFor(o);

    await arm(state);

    expect(state.armedId).toBeNull();
    expect(o.store).toEqual({});
    expect(text('status')).toMatch(/Slå det fra der/);
    expect(visible('disarm')).toBe(false);
  });

  it('shows the server\'s message when arming is refused', async () => {
    const o = fakeOutlook();
    vi.mocked(armMeeting).mockRejectedValue(new ApiError('Du er ikke inviteret.', 'not_invited', 404));
    const state = stateFor(o);

    await arm(state);

    expect(text('status')).toBe('Du er ikke inviteret.');
    expect(document.getElementById('status')!.dataset.tone).toBe('error');
    expect(state.armedId).toBeNull();
    expect(o.store).toEqual({});
    expect((document.getElementById('arm') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('disarm', () => {
  it('switches the meeting off and forgets the note', async () => {
    const o = fakeOutlook();
    vi.mocked(armMeeting).mockResolvedValue(armResponse());
    const state = stateFor(o);
    await arm(state);
    vi.mocked(disarmMeeting).mockResolvedValue({ ok: true, disarmed: true });

    await disarm(state);

    expect(disarmMeeting).toHaveBeenCalledWith('ol-1', 'token');
    expect(state.armedId).toBeNull();
    expect(o.store).toEqual({});
    expect(text('status')).toMatch(/slået fra/);
    expect(visible('arm')).toBe(true);
  });

  it('forgets the note when the server no longer has the meeting (404)', async () => {
    const o = fakeOutlook();
    vi.mocked(armMeeting).mockResolvedValue(armResponse());
    const state = stateFor(o);
    await arm(state);
    vi.mocked(disarmMeeting).mockRejectedValue(new ApiError('Mødet er ikke slået til fra Outlook.', 'not_found', 404));

    await disarm(state);

    expect(state.armedId).toBeNull();
    expect(o.store).toEqual({});
    expect(text('status')).toMatch(/allerede slået fra/);
    expect(document.getElementById('status')!.dataset.tone).toBe('ok');
  });

  it('keeps the note when switching off fails for another reason', async () => {
    const o = fakeOutlook();
    vi.mocked(armMeeting).mockResolvedValue(armResponse());
    const state = stateFor(o);
    await arm(state);
    const note = { ...o.store };
    vi.mocked(disarmMeeting).mockRejectedValue(new ApiError('Der opstod en uventet fejl. Prøv igen.', 'internal', 500));

    await disarm(state);

    expect(state.armedId).toBe('ol-1');
    expect(o.store).toEqual(note);
    expect(document.getElementById('status')!.dataset.tone).toBe('error');
    expect(visible('disarm')).toBe(true);
  });
});

describe('start', () => {
  it('says "slået til" and offers "Slå fra" when reopened on the meeting it armed', async () => {
    const o = fakeOutlook();
    vi.mocked(armMeeting).mockResolvedValue(armResponse());
    await arm(stateFor(o));
    document.body.innerHTML = main;
    (globalThis as { Office?: unknown }).Office = o.office;

    await start();

    expect(text('status')).toBe('OS2taletiltekst er slået til for mødet.');
    expect(visible('disarm')).toBe(true);
    expect(visible('arm')).toBe(false);
  });

  it('does not offer to switch off another meeting when the Teams link was swapped', async () => {
    const OTHER = 'https://teams.microsoft.com/meet/399000000000002?p=FaKeFaKeFaKe0002';
    const armed = fakeOutlook();
    vi.mocked(armMeeting).mockResolvedValue(armResponse());
    await arm(stateFor(armed));
    // The same appointment, its note intact, now with another meeting's link.
    const swapped = fakeOutlook({ body: `<a href="${OTHER}">Deltag</a>`, props: armed.store });
    document.body.innerHTML = main;
    (globalThis as { Office?: unknown }).Office = swapped.office;

    await start();

    expect(text('status')).toMatch(/Mødet har et Teams-link/);
    expect(visible('disarm')).toBe(false);
    expect(visible('arm')).toBe(true);
  });

  it('treats a bare id noted by an earlier version as unverified: "Slå til" re-arms it', async () => {
    const o = fakeOutlook({ props: { os2taletiltekstMeetingId: 'ol-1' } });
    (globalThis as { Office?: unknown }).Office = o.office;

    await start();

    expect(visible('arm')).toBe(true);
    expect(visible('disarm')).toBe(false);
  });

  it('offers "Slå til" for a meeting with a Teams link', async () => {
    (globalThis as { Office?: unknown }).Office = fakeOutlook().office;

    await start();

    expect(text('status')).toMatch(/Mødet har et Teams-link/);
    expect(visible('arm')).toBe(true);
    expect(visible('disarm')).toBe(false);
  });

  it('says what to do when the meeting has no Teams link yet', async () => {
    (globalThis as { Office?: unknown }).Office = fakeOutlook({ body: '<p>Dagsorden</p>' }).office;

    await start();

    expect(text('status')).toMatch(/send invitationen/);
    expect(visible('arm')).toBe(false);
  });

  // Arming sets recordAutomatically on the one Teams meeting a series shares, so
  // Teams records every occurrence. Said up front; arming is not blocked.
  it.each(['series', 'occurrence'] as const)('warns that Teams records the whole series (%s)', async (series) => {
    (globalThis as { Office?: unknown }).Office = fakeOutlook({ series }).office;

    await start();

    expect(visible('series')).toBe(true);
    expect(text('series')).toMatch(/del af en serie\.\s+Teams optager alle møder i serien/);
    expect(visible('arm')).toBe(true);
  });

  it.each(['none', 'legacy'] as const)('says nothing about a series for a single meeting (%s)', async (series) => {
    (globalThis as { Office?: unknown }).Office = fakeOutlook({ series }).office;

    await start();

    expect(visible('series')).toBe(false);
    expect(visible('arm')).toBe(true);
  });

  it('needs Outlook', async () => {
    await start();
    expect(text('status')).toMatch(/åbnes fra Outlook/);
  });

  // The note must not promise a deletion the deployment does not do
  // (TEAMS_DELETE_RECORDING=false, or transcript-only mode).
  it('says the recording is deleted once the transcript is saved, when the server deletes it', async () => {
    vi.mocked(loadConfig).mockResolvedValue({ ...CONFIG, deletesRecording: true });
    (globalThis as { Office?: unknown }).Office = fakeOutlook().office;

    await start();

    expect(text('recording-note')).toMatch(/slettes.*når du har åbnet mødet i OS2taletiltekst/);
  });

  it('says the recording stays in Teams when the server does not delete it', async () => {
    vi.mocked(loadConfig).mockResolvedValue({ ...CONFIG, deletesRecording: false });
    (globalThis as { Office?: unknown }).Office = fakeOutlook().office;

    await start();

    expect(text('recording-note')).toMatch(/sletter ikke optagelsen/);
    expect(text('recording-note')).not.toMatch(/slettes/);
  });

  it('promises nothing about the recording when the server cannot be asked', async () => {
    vi.mocked(loadConfig).mockRejectedValue(new Error('Kunne ikke få forbindelse til OS2taletiltekst.'));
    (globalThis as { Office?: unknown }).Office = fakeOutlook().office;

    await start();

    expect(text('recording-note')).toBe('');
    expect(document.querySelector('.note')!.textContent).not.toMatch(/slet/);
    expect(visible('arm')).toBe(true);
  });
});

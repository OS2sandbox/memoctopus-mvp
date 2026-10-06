import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, type EventType } from './events';
import { summariseEvent, type SummarisableEvent } from './summary.da';

const NAME = 'Mette Eksempelsen';
const ev = (eventType: string, over: Partial<SummarisableEvent> = {}): SummarisableEvent => ({
  eventType,
  outcome: 'success',
  source: 'server',
  actorUserId: 'u1',
  actorName: NAME,
  details: {},
  ...over,
});

// One expectation per catalogue type: the table is typed over EventType, so a new type must be added here too.
const CASES: Record<EventType, [SummarisableEvent, string]> = {
  'auth.login': [ev('auth.login', { details: { method: 'password', provider: 'credential' } }), `${NAME} loggede ind med adgangskode`],
  'auth.logout': [ev('auth.logout'), `${NAME} loggede ud`],
  'auth.login_failed': [
    ev('auth.login_failed', { outcome: 'error', actorUserId: null, actorName: null, details: { reason: 'rate_limited' } }),
    'Mislykket login-forsøg (for mange forsøg)',
  ],
  'authz.denied': [ev('authz.denied', { outcome: 'denied', details: { required: 'audit.read', reason: 'missing_capability' } }), `${NAME} fik adgang nægtet til »Læse loggen«`],
  'template.create': [ev('template.create'), `${NAME} oprettede en skabelon`],
  'template.update': [ev('template.update', { details: { changedFields: ['prompt'] } }), `${NAME} ændrede en skabelon`],
  'template.delete': [ev('template.delete'), `${NAME} slettede en skabelon`],
  'template.share': [ev('template.share', { details: { kind: 'link' } }), `${NAME} delte en skabelon via link`],
  'template.import': [ev('template.import', { details: { kind: 'link' } }), `${NAME} importerede en skabelon fra et link`],
  'central_template.create': [ev('central_template.create', { templateName: 'Test af prompt', details: { version: 1, targetCount: 2 } }), `${NAME} oprettede den centrale skabelon »Test af prompt«`],
  'central_template.update': [ev('central_template.update', { templateName: 'X', details: { version: 3, changedFields: ['prompt'] } }), `${NAME} ændrede den centrale skabelon »X« (version 3)`],
  'central_template.retarget': [ev('central_template.retarget', { templateName: 'X', details: { version: 4, targetCount: 1 } }), `${NAME} ændrede, hvem der har den centrale skabelon »X« til rådighed (version 4)`],
  'central_template.archive': [ev('central_template.archive', { templateName: 'X', details: { version: 5 } }), `${NAME} arkiverede den centrale skabelon »X« (version 5)`],
  'central_template.restore': [ev('central_template.restore', { templateName: 'X', details: { version: 6 } }), `${NAME} genoprettede den centrale skabelon »X« (version 6)`],
  'minutes.generate': [ev('minutes.generate', { details: { templateSource: 'personal', durationMs: 5, segmentCount: 2 } }), `${NAME} genererede et referat`],
  'export.download': [ev('export.download', { details: { format: 'pdf' } }), `${NAME} hentede en eksport (pdf)`],
  'bot.session_start': [ev('bot.session_start'), `${NAME} startede mødebotten`],
  'bot.session_stop': [ev('bot.session_stop'), `${NAME} stoppede mødebotten`],
  'bot.session_abort': [ev('bot.session_abort'), `${NAME} afbrød mødebotten`],
  'bot.ended': [ev('bot.ended', { source: 'system', actorUserId: null, actorName: null, details: { durationSeconds: 1800 } }), 'Mødebotten forlod mødet efter 30 min.'],
  'bot.error': [ev('bot.error', { source: 'system', outcome: 'error', actorUserId: null, actorName: null, details: { code: 'join_failed' } }), 'Mødebotten fejlede'],
  'meeting.create': [ev('meeting.create', { source: 'client', details: { origin: 'upload' } }), `${NAME} oprettede et møde (upload)`],
  'meeting.delete': [ev('meeting.delete', { source: 'client' }), `${NAME} slettede et møde`],
  'meeting.redact': [ev('meeting.redact', { source: 'client' }), `${NAME} slørede et møde`],
  'meeting.audio_delete': [ev('meeting.audio_delete', { source: 'client' }), `${NAME} slettede lyden fra et møde`],
  'access.role_assign': [ev('access.role_assign', { details: { roleKey: 'tt-logleser' } }), `${NAME} tildelte en bruger rollen »Logleser«`],
  'access.role_revoke': [ev('access.role_revoke', { details: { roleKey: 'tt-administrator' } }), `${NAME} fjernede rollen »Administrator« fra en bruger`],
  'access.org_unit_create': [ev('access.org_unit_create'), `${NAME} oprettede en organisationsenhed`],
  'access.org_unit_update': [ev('access.org_unit_update', { details: { nameChanged: true, parentChanged: true } }), `${NAME} ændrede en organisationsenhed (navn og placering)`],
  'access.org_unit_delete': [ev('access.org_unit_delete'), `${NAME} slettede en organisationsenhed`],
  'access.member_add': [ev('access.member_add'), `${NAME} tilføjede en bruger til en organisationsenhed`],
  'access.member_remove': [ev('access.member_remove'), `${NAME} fjernede en bruger fra en organisationsenhed`],
  'access.user_create': [ev('access.user_create', { details: { source: 'local' } }), `${NAME} oprettede en bruger i organisationen`],
  'access.user_link': [ev('access.user_link', { details: { via: 'email', automatic: true } }), `${NAME} blev automatisk koblet til sin brugerprofil i organisationen`],
  'audit.export': [ev('audit.export', { details: { rowCount: 1200, format: 'csv' } }), `${NAME} eksporterede loggen (1.200 rækker)`],
  'audit.prune': [ev('audit.prune', { source: 'system', actorUserId: null, actorName: null, details: { deletedCount: 1, olderThanDays: 365 } }), 'Systemet slettede 1 logpost ældre end 365 dage'],
};

describe('summariseEvent', () => {
  it.each(EVENT_TYPES)('has a sentence for %s', (type) => {
    const [event, expected] = CASES[type];
    expect(summariseEvent(event)).toBe(expected);
  });

  it('covers exactly the catalogue', () => {
    expect(Object.keys(CASES).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('names an unknown actor and the system', () => {
    expect(summariseEvent(ev('auth.login', { actorName: null }))).toBe('Ukendt bruger loggede ind');
    expect(summariseEvent(ev('auth.login', { actorName: '  ', actorUserId: null, source: 'system' }))).toBe('Systemet loggede ind');
    expect(summariseEvent(ev('audit.prune', { actorName: null, actorUserId: null, source: 'system', details: { deletedCount: 3, olderThanDays: 30 } }))).toBe(
      'Systemet slettede 3 logposter ældre end 30 dage',
    );
  });

  it('handles a central template without a known name or version', () => {
    expect(summariseEvent(ev('central_template.update', { details: {} }))).toBe(`${NAME} ændrede en central skabelon`);
    expect(summariseEvent(ev('central_template.create', { templateName: null }))).toBe(`${NAME} oprettede en central skabelon`);
  });

  it('shows a failed minutes generation or export as failed', () => {
    expect(summariseEvent(ev('minutes.generate', { outcome: 'error', details: {} }))).toBe(`${NAME} kunne ikke generere et referat`);
    expect(summariseEvent(ev('export.download', { outcome: 'error', details: { format: 'docx' } }))).toBe(`${NAME} kunne ikke hente en eksport (docx)`);
  });

  it('mentions the central template of generated minutes', () => {
    expect(summariseEvent(ev('minutes.generate', { details: { templateSource: 'central', templateVersion: 2 } }))).toBe(
      `${NAME} genererede et referat med en central skabelon (version 2)`,
    );
  });

  it('does not name a template for non-central events, even if one is passed', () => {
    expect(summariseEvent(ev('template.update', { templateName: 'Hemmeligt navn' }))).not.toContain('Hemmeligt');
  });

  it('shows a truncated export and singular counts', () => {
    expect(summariseEvent(ev('audit.export', { details: { rowCount: 1, format: 'csv', truncated: true } }))).toBe(`${NAME} eksporterede loggen (1 række, afkortet)`);
  });

  it('never repeats free text or unknown values from details', () => {
    const s = summariseEvent(ev('authz.denied', { details: { required: 'EVIL<script>', reason: 'x' } }));
    expect(s).toBe(`${NAME} fik adgang nægtet`);
    expect(summariseEvent(ev('access.role_assign', { details: { roleKey: 'hacker' } }))).toBe(`${NAME} tildelte en bruger rollen en rolle`);
    expect(summariseEvent(ev('auth.login_failed', { details: { reason: 'free text here' } }))).toBe('Mislykket login-forsøg');
  });

  it('falls back to the stored label for a legacy type', () => {
    expect(summariseEvent(ev('legacy.thing'))).toBe(`${NAME}: legacy.thing`);
  });
});

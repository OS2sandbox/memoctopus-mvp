// Traceability from the client's logging specification to the event catalogue: one row per
// requirement, naming the event type that satisfies it. A requirement whose event is removed
// or renamed fails here, so the contract with the client cannot erode unnoticed. Each row also
// has a sample event that must pass the same validation the server applies, a label, a category
// and a Danish sentence (those three are exhaustive Records, this checks the sample reads well).
import { describe, expect, it, vi } from 'vitest';

// record.ts opens the database at import time; only the pure validateEvent is used here.
vi.mock('@/lib/db', () => ({ db: {}, pool: { query: vi.fn(), connect: vi.fn() } }));

import { CATEGORY_OF } from './categories';
import { EVENT_CATALOGUE, isEventType, type AuditEventInput } from './events';
import { eventTypeLabels } from './labels.da';
import { validateEvent } from './record';
import { summariseEvent } from './summary.da';

const MEETING = '11111111-2222-4333-8444-555555555555';
const client = { source: 'client', actorUserId: 'u1', entityId: MEETING };
const server = { actorUserId: 'u1', entityId: MEETING };
const system = { source: 'system' };

interface Row {
  /** The requirement, as the specification words it. */
  requirement: string;
  type: string;
  /** What is logged for it, besides the type. */
  sample: Record<string, unknown>;
  /** Where it comes from: what the server saw, what only the browser can report, or the system itself. */
  trust: 'server' | 'self-reported' | 'system';
}

const ROWS: Row[] = [
  // Login and access
  { requirement: 'Login', type: 'auth.login', sample: { source: 'server', actorUserId: 'u1', details: { method: 'oidc', provider: 'oidc' } }, trust: 'server' },
  { requirement: 'Logout', type: 'auth.logout', sample: { source: 'server', actorUserId: 'u1', details: {} }, trust: 'server' },
  { requirement: 'Failed login', type: 'auth.login_failed', sample: { source: 'server', details: { reason: 'invalid_credentials' } }, trust: 'server' },
  { requirement: 'Access denied (probing other people\'s data)', type: 'authz.denied', sample: { source: 'server', actorUserId: 'u1', details: { required: 'bot.meeting_owner', reason: 'not_owner' } }, trust: 'server' },
  // Prompts
  { requirement: 'Personal template created', type: 'template.create', sample: { actorUserId: 'u1', details: { hasPrompt: true } }, trust: 'server' },
  { requirement: 'Personal template changed (with changelog)', type: 'template.update', sample: { actorUserId: 'u1', details: { changedFields: ['prompt'], hasChangeNote: true } }, trust: 'server' },
  { requirement: 'Personal template deleted', type: 'template.delete', sample: { actorUserId: 'u1', details: {} }, trust: 'server' },
  { requirement: 'Common prompt changed', type: 'central_template.update', sample: { ...server, details: { version: 2, changedFields: ['prompt'] } }, trust: 'server' },
  { requirement: 'Common prompt withdrawn or retargeted', type: 'central_template.retarget', sample: { ...server, details: { version: 3, targetCount: 1, principalTargetCount: 1 } }, trust: 'server' },
  { requirement: 'Common prompt deleted (archived)', type: 'central_template.archive', sample: { ...server, details: { version: 4 } }, trust: 'server' },
  // Generation, export, upload
  { requirement: 'Minutes generated (with result, and whether an instruction was supplied)', type: 'minutes.generate', sample: { ...server, details: { templateSource: 'none', userInstruction: true, durationMs: 10, segmentCount: 2 } }, trust: 'server' },
  { requirement: 'Export of minutes', type: 'export.download', sample: { ...server, details: { format: 'pdf' } }, trust: 'server' },
  { requirement: 'Audio upload (live recording, file, batch, bot, speaker detection)', type: 'audio.upload', sample: { ...server, details: { channel: 'live', bytes: 10 } }, trust: 'server' },
  // Views and playback
  { requirement: 'View minutes', type: 'meeting.minutes_view', sample: { ...client, details: {} }, trust: 'self-reported' },
  { requirement: 'View transcript', type: 'meeting.transcript_view', sample: { ...client, details: {} }, trust: 'self-reported' },
  { requirement: 'View an earlier version of the minutes', type: 'meeting.minutes_version', sample: { ...client, details: { versionNumber: 1, action: 'view' } }, trust: 'self-reported' },
  { requirement: 'Restore a version (an in-app version switch)', type: 'meeting.minutes_version', sample: { ...client, details: { versionNumber: 1, action: 'activate' } }, trust: 'self-reported' },
  { requirement: 'Audio playback', type: 'meeting.audio_play', sample: { ...client, details: {} }, trust: 'self-reported' },
  // Edits
  { requirement: 'Edit minutes', type: 'meeting.minutes_save', sample: { ...client, details: {} }, trust: 'self-reported' },
  { requirement: 'Edit transcript', type: 'meeting.transcript_edit', sample: { ...client, details: {} }, trust: 'self-reported' },
  { requirement: 'New version of the minutes', type: 'meeting.minutes_version', sample: { ...client, details: { versionNumber: 2, action: 'snapshot' } }, trust: 'self-reported' },
  { requirement: 'Version-cap pruning of old versions', type: 'meeting.minutes_version_prune', sample: { ...client, details: { prunedCount: 1 } }, trust: 'self-reported' },
  { requirement: 'Metadata: title or date of a meeting', type: 'meeting.metadata_edit', sample: { ...client, details: { field: 'title' } }, trust: 'self-reported' },
  { requirement: 'Metadata: participants', type: 'meeting.participants_edit', sample: { ...client, details: { participantCount: 3 } }, trust: 'self-reported' },
  { requirement: 'Metadata: voices and speakers', type: 'meeting.speakers_edit', sample: { ...client, details: { speakerCount: 2 } }, trust: 'self-reported' },
  // Recording
  { requirement: 'Local recording started', type: 'meeting.recording_start', sample: { ...client, details: {} }, trust: 'self-reported' },
  { requirement: 'Local recording paused', type: 'meeting.recording_pause', sample: { ...client, details: {} }, trust: 'self-reported' },
  { requirement: 'Local recording resumed', type: 'meeting.recording_resume', sample: { ...client, details: {} }, trust: 'self-reported' },
  { requirement: 'Local recording stopped', type: 'meeting.recording_stop', sample: { ...client, details: {} }, trust: 'self-reported' },
  { requirement: 'Meeting bot paused', type: 'bot.session_pause', sample: { ...server, details: {} }, trust: 'server' },
  { requirement: 'Meeting bot resumed', type: 'bot.session_resume', sample: { ...server, details: {} }, trust: 'server' },
  // Deletion
  { requirement: 'Meeting deleted (by the person or automatically)', type: 'meeting.delete', sample: { ...client, details: { trigger: 'auto_pagehide' } }, trust: 'self-reported' },
  { requirement: 'Audio deleted (by the person or automatically)', type: 'meeting.audio_delete', sample: { ...client, details: { trigger: 'auto_generate' } }, trust: 'self-reported' },
  { requirement: 'Server-held bot recording deleted', type: 'bot.audio_delete', sample: { ...system, details: { trigger: 'ttl' } }, trust: 'system' },
  { requirement: 'Server-held bot transcript deleted', type: 'bot.audio_delete', sample: { ...system, details: { trigger: 'handoff', object: 'transcript' } }, trust: 'system' },
  // System
  { requirement: 'Change of system or integration configuration', type: 'system.config_changed', sample: { ...system, details: { fingerprint: '0123456789abcdef', changed: true, changedKeys: ['ACCESS_SOURCE'] } }, trust: 'system' },
  // The log itself
  { requirement: 'Export of the log is logged', type: 'audit.export', sample: { source: 'server', actorUserId: 'u1', details: { rowCount: 1, format: 'csv' } }, trust: 'server' },
  { requirement: 'Retention: deletion of old log rows is logged', type: 'audit.prune', sample: { ...system, details: { deletedCount: 1, olderThanDays: 365 } }, trust: 'system' },
  { requirement: 'Events the log did not store are counted and visible', type: 'audit.events_dropped', sample: { ...system, actorUserId: 'u1', details: { reason: 'daily_cap', count: 2 } }, trust: 'system' },
];

describe('client specification -> event catalogue', () => {
  it.each(ROWS.map((r) => [r.requirement, r] as const))('%s', (_requirement, row) => {
    expect(isEventType(row.type), `${row.type} is missing from the catalogue`).toBe(true);
    expect(EVENT_CATALOGUE).toHaveProperty([row.type]);
    // The sample is a valid event with the trust level the row claims.
    const sample = { type: row.type, ...row.sample } as unknown as AuditEventInput;
    const result = validateEvent(sample);
    expect(result, JSON.stringify(row.sample)).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.source === 'client').toBe(row.trust === 'self-reported');
      expect(result.value.source === 'system').toBe(row.trust === 'system');
    }
    // Readable in the viewer.
    expect(eventTypeLabels[row.type as keyof typeof eventTypeLabels]).toBeTruthy();
    expect(CATEGORY_OF[row.type as keyof typeof CATEGORY_OF]).toBeTruthy();
    const sentence = summariseEvent({
      eventType: row.type,
      outcome: 'success',
      source: result.ok ? result.value.source : undefined,
      actorUserId: 'u1',
      actorName: 'Anne Admin',
      details: (row.sample.details ?? {}) as Record<string, unknown>,
    });
    expect(sentence.length).toBeGreaterThan(5);
    expect(sentence).not.toContain('Ukendt hændelsestype');
  });

  it('every event type of the catalogue serves at least one requirement (no event without a reason to exist)', () => {
    const used = new Set(ROWS.map((r) => r.type));
    // Types that are supporting parts of a requirement rather than a requirement of their own.
    const supporting = new Set([
      'template.share', 'template.import', 'central_template.create', 'central_template.restore',
      'bot.session_start', 'bot.session_stop', 'bot.session_abort', 'bot.ended', 'bot.error',
      'meeting.create', 'meeting.redact',
    ]);
    const orphans = Object.keys(EVENT_CATALOGUE).filter((t) => !used.has(t) && !supporting.has(t));
    expect(orphans).toEqual([]);
  });
});

// The heart of the "no content" guarantee. Every event type and every
// string-typed field in its details schema is fed transcript-like text, an over
// long string, an email, a URL and a file name, at the catalogue level and
// through validateEvent / recordEvent, and must be rejected.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const poolQuery = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ db: {}, pool: { query: poolQuery, connect: vi.fn() } }));

import { AuditWriteError, recordEvent, validateEvent } from '../record';
import { EVENT_CATALOGUE, EVENT_TYPES, type AuditEventInput, type EventType } from './index';
import { aiEvents } from './ai';
import { auditEvents } from './audit';
import { authEvents } from './auth';
import { botEvents } from './bot';
import { centralTemplateEvents } from './central-template';
import { meetingEvents } from './meeting';
import { systemEvents } from './system';
import { templateEvents } from './template';
import { CODE_RE } from './types';

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const BAD_STRINGS: Record<string, string> = {
  transcript: 'Vi skal tale om sagen om Jensens barn.',
  tooLong: 'a'.repeat(65),
  email: 'jens.jensen@example.dk',
  url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting',
  fileName: 'Møde referat 2026.docx',
};

type Def = { _def: { typeName: string; [k: string]: unknown } } & z.ZodTypeAny;

function unwrap(s: z.ZodTypeAny): z.ZodTypeAny {
  let cur = s as Def;
  while (['ZodOptional', 'ZodNullable', 'ZodDefault'].includes(cur._def.typeName)) {
    cur = cur._def.innerType as Def;
  }
  return cur;
}

interface Leaf {
  key: string;
  inArray: boolean;
  schema: z.ZodTypeAny;
  kind: 'string' | 'enum' | 'other';
}

function leaves(details: z.ZodTypeAny): Leaf[] {
  const obj = unwrap(details) as unknown as z.ZodObject<z.ZodRawShape>;
  expect(obj._def.typeName).toBe('ZodObject');
  return Object.entries(obj.shape).map(([key, raw]) => {
    let s = unwrap(raw);
    const inArray = (s as Def)._def.typeName === 'ZodArray';
    if (inArray) s = unwrap((s as Def)._def.type as z.ZodTypeAny);
    const t = (s as Def)._def.typeName;
    const kind = t === 'ZodString' ? 'string' : t === 'ZodEnum' ? 'enum' : 'other';
    return { key, inArray, schema: s, kind };
  });
}

/** A value that the leaf's schema accepts (verified by the tests that use it). */
function sampleOf(s: z.ZodTypeAny): unknown {
  const inner = unwrap(s) as Def;
  switch (inner._def.typeName) {
    case 'ZodString': {
      const checks = (inner._def.checks as Array<{ kind: string }>) ?? [];
      if (checks.some((c) => c.kind === 'uuid')) return UUID_A;
      const ok = ['sample_code', '0123456789abcdef', '0123456789abcdef0123456789abcdef'].find((c) => inner.safeParse(c).success);
      if (!ok) throw new Error('no sample string for a regex-constrained field');
      return ok;
    }
    case 'ZodEnum':
      return (inner._def.values as string[])[0];
    case 'ZodNumber':
      return 1;
    case 'ZodBoolean':
      return true;
    case 'ZodArray':
      return [sampleOf(inner._def.type as z.ZodTypeAny)];
    default:
      throw new Error(`no sample for ${inner._def.typeName}`);
  }
}

function fullDetails(type: EventType): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const l of leaves(EVENT_CATALOGUE[type].details)) {
    const obj = unwrap(EVENT_CATALOGUE[type].details) as unknown as z.ZodObject<z.ZodRawShape>;
    out[l.key] = sampleOf(obj.shape[l.key]);
  }
  return out;
}

/** A minimal event that is valid for the type, with `details` as given. */
function eventFor(type: EventType, details: unknown): AuditEventInput {
  const def = EVENT_CATALOGUE[type];
  const e: Record<string, unknown> = {
    type,
    source: def.sources[0],
    actorUserId: 'user-1',
    details,
  };
  if (def.entityType !== null) {
    e.entityId = UUID_A;
  }
  if ('anyEntityType' in def && def.anyEntityType) e.entityType = 'org_unit';
  return e as unknown as AuditEventInput;
}

describe('catalogue structure', () => {
  it('is exactly the action set: what people did, never content, pipeline steps or sync status', () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        'auth.login', 'auth.logout', 'auth.login_failed', 'authz.denied',
        'template.create', 'template.update', 'template.delete', 'template.share', 'template.import',
        'central_template.create', 'central_template.update', 'central_template.retarget', 'central_template.archive', 'central_template.restore',
        'audio.upload', 'minutes.generate', 'export.download',
        'bot.session_start', 'bot.session_pause', 'bot.session_resume', 'bot.session_stop', 'bot.session_abort',
        'bot.audio_delete', 'bot.ended', 'bot.error',
        'meeting.create', 'meeting.delete', 'meeting.redact', 'meeting.audio_delete',
        'meeting.minutes_view', 'meeting.transcript_view', 'meeting.audio_play',
        'meeting.recording_start', 'meeting.recording_pause', 'meeting.recording_resume', 'meeting.recording_stop',
        'meeting.minutes_save', 'meeting.minutes_version', 'meeting.minutes_version_prune',
        'meeting.participants_edit', 'meeting.speakers_edit',
        'system.config_changed',
        'audit.export', 'audit.prune',
      ].sort(),
    );
  });

  it('has no event type defined in two domain files (a spread would silently override)', () => {
    const files = [authEvents, templateEvents, centralTemplateEvents, aiEvents, botEvents, meetingEvents, systemEvents, auditEvents];
    const all = files.flatMap((f) => Object.keys(f));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(EVENT_TYPES.length);
  });

  it('is domain-scoped: each file only defines its own prefixes', () => {
    const prefixes = (f: object) => new Set(Object.keys(f).map((k) => k.split('.')[0]));
    expect([...prefixes(authEvents)].sort()).toEqual(['auth', 'authz']);
    expect([...prefixes(templateEvents)]).toEqual(['template']);
    expect([...prefixes(centralTemplateEvents)]).toEqual(['central_template']);
    expect([...prefixes(aiEvents)].sort()).toEqual(['audio', 'export', 'minutes']);
    expect([...prefixes(botEvents)]).toEqual(['bot']);
    expect([...prefixes(meetingEvents)]).toEqual(['meeting']);
    expect([...prefixes(systemEvents)]).toEqual(['system']);
    expect([...prefixes(auditEvents)]).toEqual(['audit']);
  });

  it('allows the browser to report only meeting.*', () => {
    const clientTypes = EVENT_TYPES.filter((t) => (EVENT_CATALOGUE[t].sources as readonly string[]).includes('client'));
    expect([...clientTypes].sort()).toEqual(Object.keys(meetingEvents).sort());
  });

  it('has no access.* events: rights and organisation changes are out of the log', () => {
    expect(EVENT_TYPES.filter((t) => t.startsWith('access.'))).toEqual([]);
  });

  it('keeps meeting.* client-only (they are self-reported)', () => {
    for (const t of Object.keys(meetingEvents) as EventType[]) {
      expect(EVENT_CATALOGUE[t].sources).toEqual(['client']);
    }
  });
});

describe('details schemas can only express codes, enums, numbers, booleans and uuids', () => {
  for (const type of EVENT_TYPES) {
    describe(type, () => {
      const def = EVENT_CATALOGUE[type];

      it('is a strict object that rejects unknown keys', () => {
        const full = fullDetails(type);
        expect(def.details.safeParse(full).success).toBe(true);
        expect(def.details.safeParse({ ...full, extra: 'code' }).success).toBe(false);
        expect(def.details.safeParse({ ...full, title: 'Budgetmøde' }).success).toBe(false);
        expect(validateEvent(eventFor(type, { ...full, extra: 'code' })).ok).toBe(false);
      });

      it('accepts a fully populated valid event (positive control)', () => {
        const res = validateEvent(eventFor(type, fullDetails(type)));
        expect(res).toMatchObject({ ok: true });
      });

      it('never uses an unconstrained string', () => {
        for (const l of leaves(def.details)) {
          if (l.kind !== 'string') continue;
          const checks = ((l.schema as Def)._def.checks as Array<{ kind: string; regex?: RegExp }>) ?? [];
          const constrained = checks.some((c) => c.kind === 'uuid' || (c.kind === 'regex' && c.regex));
          expect(constrained, `${type}.${l.key} is a bare z.string()`).toBe(true);
        }
      });

      for (const l of leaves(def.details)) {
        if (l.kind === 'other') continue;
        for (const [label, bad] of Object.entries(BAD_STRINGS)) {
          it(`rejects ${label} text in ${l.key}`, () => {
            const base = fullDetails(type);
            const poisoned = { ...base, [l.key]: l.inArray ? [bad] : bad };

            expect(def.details.safeParse(poisoned).success).toBe(false);
            expect(validateEvent(eventFor(type, poisoned)).ok).toBe(false);
          });
        }
      }
    });
  }

  it('rejects text through recordEvent (drop) and recordEvent with tx (throw), without writing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tx = { query: vi.fn() };
    let checked = 0;
    for (const type of EVENT_TYPES) {
      for (const l of leaves(EVENT_CATALOGUE[type].details)) {
        if (l.kind === 'other') continue;
        const poisoned = { ...fullDetails(type), [l.key]: l.inArray ? [BAD_STRINGS.transcript] : BAD_STRINGS.transcript };
        const event = eventFor(type, poisoned);
        const dropped = await recordEvent(event as never);
        expect(dropped.status).toBe('dropped');
        await expect(recordEvent(event as never, { tx })).rejects.toBeInstanceOf(AuditWriteError);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
    expect(tx.query).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain('Jensens');
    warn.mockRestore();
  });

  it('rejects the wrong primitive for number and boolean fields', () => {
    for (const type of EVENT_TYPES) {
      const obj = unwrap(EVENT_CATALOGUE[type].details) as unknown as z.ZodObject<z.ZodRawShape>;
      for (const [key, raw] of Object.entries(obj.shape)) {
        const t = (unwrap(raw) as Def)._def.typeName;
        if (t !== 'ZodNumber' && t !== 'ZodBoolean') continue;
        const poisoned = { ...fullDetails(type), [key]: BAD_STRINGS.transcript };
        expect(EVENT_CATALOGUE[type].details.safeParse(poisoned).success, `${type}.${key}`).toBe(false);
      }
    }
  });

  it('only ever stores enum values and codes that satisfy the central code regex', () => {
    for (const type of EVENT_TYPES) {
      const res = validateEvent(eventFor(type, fullDetails(type)));
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      const strings = Object.values(res.value.details).flat().filter((v): v is string => typeof v === 'string');
      for (const s of strings) expect(CODE_RE.test(s), `${type}: ${s}`).toBe(true);
    }
  });
});

describe('central template events (Phase 4)', () => {
  const event = (type: EventType, details: unknown, extra: Record<string, unknown> = {}) =>
    ({ type, actorUserId: 'user-1', entityId: UUID_A, secondaryEntityId: UUID_B, details, ...extra }) as unknown as AuditEventInput;

  it('accept the details the service writes, with the owning org unit as secondary entity', () => {
    const cases: Array<[EventType, Record<string, unknown>]> = [
      ['central_template.create', { version: 1, targetCount: 3 }],
      ['central_template.update', { version: 2, changedFields: ['prompt', 'allowUserInstruction', 'targets'] }],
      ['central_template.retarget', { version: 3, targetCount: 0 }],
      ['central_template.archive', { version: 4 }],
      ['central_template.restore', { version: 5 }],
    ];
    for (const [type, details] of cases) {
      const res = validateEvent(event(type, details));
      expect(res, type).toMatchObject({ ok: true });
      if (res.ok) {
        expect(res.value.entityType).toBe('central_template');
        expect(res.value.secondaryEntityType).toBe('org_unit');
      }
    }
  });

  it('records field NAMES only: a value or an unknown field is rejected', () => {
    expect(validateEvent(event('central_template.update', { version: 2, changedFields: ['Ny prompt til alle'] })).ok).toBe(false);
    expect(validateEvent(event('central_template.update', { version: 2, changedFields: ['changeNote'] })).ok).toBe(false);
    expect(validateEvent(event('central_template.update', { version: 2, changedFields: ['prompt'], changeNote: 'Rettet' })).ok).toBe(false);
    expect(validateEvent(event('central_template.create', { version: 1, targetCount: 1, name: 'Referat' })).ok).toBe(false);
  });

  it('requires a version of at least 1 and an entity id', () => {
    expect(validateEvent(event('central_template.archive', { version: 0 })).ok).toBe(false);
    expect(validateEvent({ type: 'central_template.archive', details: { version: 1 } } as unknown as AuditEventInput)).toEqual({
      ok: false,
      code: 'entity_id_required',
    });
  });

  it('minutes.generate accepts templateSource central with a templateVersion and the central template as secondary entity', () => {
    const base = { type: 'minutes.generate', actorUserId: 'user-1', secondaryEntityId: UUID_B } as const;
    const details = { templateSource: 'central', templateVersion: 7, userInstruction: false, durationMs: 10, segmentCount: 2 };
    const central = validateEvent({ ...base, secondaryEntityType: 'central_template', details } as unknown as AuditEventInput);
    expect(central).toMatchObject({ ok: true });
    if (central.ok) expect(central.value.secondaryEntityType).toBe('central_template');
    // A caller that names no type still gets the personal 'template' (existing call sites).
    const personal = validateEvent({ ...base, details: { ...details, templateSource: 'personal', templateVersion: undefined } } as unknown as AuditEventInput);
    expect(personal).toMatchObject({ ok: true });
    if (personal.ok) expect(personal.value.secondaryEntityType).toBe('template');
    expect(validateEvent({ ...base, details: { ...details, templateVersion: 0 } } as unknown as AuditEventInput).ok).toBe(false);
  });
});

describe('action events for access, processing, editing and deletion', () => {
  const meeting = (type: EventType, details: unknown, extra: Record<string, unknown> = {}) =>
    ({ type, actorUserId: 'user-1', entityId: UUID_A, details, ...extra }) as unknown as AuditEventInput;

  it('accepts the details the browser reports, with the meeting as entity', () => {
    const cases: Array<[EventType, Record<string, unknown>]> = [
      ['meeting.minutes_view', {}],
      ['meeting.transcript_view', {}],
      ['meeting.audio_play', {}],
      ['meeting.recording_start', {}],
      ['meeting.recording_pause', {}],
      ['meeting.recording_resume', {}],
      ['meeting.recording_stop', {}],
      ['meeting.minutes_save', {}],
      ['meeting.minutes_version', { versionNumber: 3, action: 'view' }],
      ['meeting.minutes_version', { versionNumber: 3, action: 'activate' }],
      ['meeting.minutes_version', { versionNumber: 4, action: 'snapshot' }],
      ['meeting.minutes_version', { versionNumber: 5, action: 'generate' }],
      ['meeting.minutes_version_prune', { prunedCount: 1 }],
      ['meeting.participants_edit', { participantCount: 4 }],
      ['meeting.speakers_edit', { speakerCount: 3 }],
      ['meeting.speakers_edit', {}],
      ['meeting.delete', { trigger: 'user' }],
      ['meeting.delete', { trigger: 'auto_leave' }],
      ['meeting.delete', {}],
      ['meeting.audio_delete', { trigger: 'auto_generate' }],
      ['meeting.audio_delete', { trigger: 'auto_pagehide' }],
      ['meeting.audio_delete', { trigger: 'auto_empty' }],
    ];
    for (const [type, details] of cases) {
      const res = validateEvent(meeting(type, details, { source: 'client' }));
      expect(res, `${type} ${JSON.stringify(details)}`).toMatchObject({ ok: true });
      if (res.ok) expect(res.value.entityType).toBe('meeting');
    }
  });

  it('rejects content-like or unknown values in those events', () => {
    const bad: Array<[EventType, Record<string, unknown>]> = [
      ['meeting.minutes_version', { versionNumber: 3, action: 'Gendannet version' }],
      ['meeting.minutes_version', { versionNumber: 3 }],
      ['meeting.minutes_version', { versionNumber: 'Referat v3', action: 'view' }],
      ['meeting.minutes_version_prune', { prunedCount: 0 }],
      ['meeting.participants_edit', { participantCount: 2, participants: ['Jens'] }],
      ['meeting.speakers_edit', { speakerCount: 2, names: ['Jens'] }],
      ['meeting.delete', { trigger: 'because I wanted to' }],
      ['meeting.audio_delete', { trigger: 'ttl' }],
      ['meeting.minutes_view', { title: 'Budgetmøde' }],
    ];
    for (const [type, details] of bad) {
      expect(validateEvent(meeting(type, details, { source: 'client' })).ok, `${type} ${JSON.stringify(details)}`).toBe(false);
    }
  });

  it('audio.upload: server or system source, meeting optional, sizes and codes only', () => {
    const ok = { channel: 'batch', bytes: 120_000, durationMs: 4200, outcomeCode: 'http_503' };
    expect(validateEvent({ type: 'audio.upload', actorUserId: 'u1', entityId: UUID_A, outcome: 'error', details: ok } as unknown as AuditEventInput)).toMatchObject({ ok: true });
    expect(validateEvent({ type: 'audio.upload', source: 'system', details: { channel: 'bot', bytes: 10 } } as unknown as AuditEventInput)).toMatchObject({ ok: true });
    expect(validateEvent({ type: 'audio.upload', source: 'client', actorUserId: 'u1', details: ok } as unknown as AuditEventInput).ok).toBe(false);
    expect(validateEvent({ type: 'audio.upload', actorUserId: 'u1', details: { ...ok, fileName: 'moede.webm' } } as unknown as AuditEventInput).ok).toBe(false);
    expect(validateEvent({ type: 'audio.upload', actorUserId: 'u1', details: { ...ok, channel: 'dropbox' } } as unknown as AuditEventInput).ok).toBe(false);
  });

  it('minutes.generate says whether an instruction took part, never what it said', () => {
    const base = { type: 'minutes.generate', actorUserId: 'u1', details: { templateSource: 'none', durationMs: 5, segmentCount: 1 } };
    expect(validateEvent(base as unknown as AuditEventInput).ok).toBe(false); // userInstruction is required
    expect(validateEvent({ ...base, details: { ...base.details, userInstruction: true } } as unknown as AuditEventInput)).toMatchObject({ ok: true });
    expect(validateEvent({ ...base, details: { ...base.details, userInstruction: 'Skriv kort' } } as unknown as AuditEventInput).ok).toBe(false);
  });

  it('bot.session_pause/resume are user actions, bot.audio_delete is a system action with a closed trigger', () => {
    expect(validateEvent({ type: 'bot.session_pause', actorUserId: 'u1', entityId: UUID_A } as unknown as AuditEventInput)).toMatchObject({ ok: true });
    expect(validateEvent({ type: 'bot.session_resume', actorUserId: 'u1', entityId: UUID_A } as unknown as AuditEventInput)).toMatchObject({ ok: true });
    const del = validateEvent({ type: 'bot.audio_delete', entityId: UUID_A, details: { trigger: 'ttl' } } as unknown as AuditEventInput);
    expect(del).toMatchObject({ ok: true });
    if (del.ok) expect(del.value.source).toBe('system');
    expect(validateEvent({ type: 'bot.audio_delete', entityId: UUID_A, details: { trigger: 'user' } } as unknown as AuditEventInput).ok).toBe(false);
  });

  it('system.config_changed: a 16-hex fingerprint and a flag, system source only', () => {
    const ok = { type: 'system.config_changed', details: { fingerprint: '0123456789abcdef', changed: true } };
    const res = validateEvent(ok as unknown as AuditEventInput);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.value.source).toBe('system');
    expect(validateEvent({ ...ok, details: { fingerprint: 'not-a-hash', changed: true } } as unknown as AuditEventInput).ok).toBe(false);
    expect(validateEvent({ ...ok, details: { fingerprint: '0123456789abcdef', changed: true, ANTHROPIC: 'x' } } as unknown as AuditEventInput).ok).toBe(false);
    expect(validateEvent({ ...ok, source: 'server' } as unknown as AuditEventInput)).toEqual({ ok: false, code: 'source_not_allowed' });
  });

  it('auth events take the login methods password, oidc, microsoft, saml and unknown, and nothing else', () => {
    for (const method of ['password', 'oidc', 'microsoft', 'saml', 'unknown']) {
      expect(validateEvent({ type: 'auth.login', details: { method, provider: 'kommune' } } as unknown as AuditEventInput).ok, method).toBe(true);
      expect(validateEvent({ type: 'auth.login_failed', details: { reason: 'oauth_error', method, provider: 'kommune' } } as unknown as AuditEventInput).ok, method).toBe(true);
    }
    expect(validateEvent({ type: 'auth.login', details: { method: 'ldap', provider: 'x' } } as unknown as AuditEventInput).ok).toBe(false);
    // No room for claim content: roles, groups and assertions have no field.
    expect(validateEvent({ type: 'auth.login', details: { method: 'saml', provider: 'x', roles: ['admin'] } } as unknown as AuditEventInput).ok).toBe(false);
  });

  it('auth.login_failed accepts a burst summary with a drop count', () => {
    const res = validateEvent({ type: 'auth.login_failed', details: { reason: 'burst_summary', droppedCount: 140 } } as unknown as AuditEventInput);
    expect(res).toMatchObject({ ok: true });
    expect(validateEvent({ type: 'auth.login_failed', details: { reason: 'burst_summary', droppedCount: 0 } } as unknown as AuditEventInput).ok).toBe(false);
  });
});

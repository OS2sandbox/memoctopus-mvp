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
import { accessEvents } from './access';
import { aiEvents } from './ai';
import { auditEvents } from './audit';
import { authEvents } from './auth';
import { botEvents } from './bot';
import { centralTemplateEvents } from './central-template';
import { meetingEvents } from './meeting';
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
      const ok = ['sample_code', '0123456789abcdef0123456789abcdef'].find((c) => inner.safeParse(c).success);
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
  it('is exactly the user-action set: no reads, pipeline steps or sync status', () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        'auth.login', 'auth.logout', 'auth.login_failed', 'authz.denied',
        'template.create', 'template.update', 'template.delete', 'template.share', 'template.import',
        'central_template.create', 'central_template.update', 'central_template.retarget', 'central_template.archive', 'central_template.restore',
        'minutes.generate', 'export.download',
        'bot.session_start', 'bot.session_stop', 'bot.session_abort', 'bot.ended', 'bot.error',
        'meeting.create', 'meeting.delete', 'meeting.redact', 'meeting.audio_delete',
        'access.role_assign', 'access.role_revoke', 'access.org_unit_create', 'access.org_unit_update', 'access.org_unit_delete',
        'access.member_add', 'access.member_remove', 'access.user_create', 'access.user_link',
        'audit.export', 'audit.prune',
      ].sort(),
    );
  });

  it('has no event type defined in two domain files (a spread would silently override)', () => {
    const files = [accessEvents, authEvents, templateEvents, centralTemplateEvents, aiEvents, botEvents, meetingEvents, auditEvents];
    const all = files.flatMap((f) => Object.keys(f));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(EVENT_TYPES.length);
  });

  it('is domain-scoped: each file only defines its own prefixes', () => {
    const prefixes = (f: object) => new Set(Object.keys(f).map((k) => k.split('.')[0]));
    expect([...prefixes(accessEvents)].sort()).toEqual(['access', 'authz']);
    expect([...prefixes(authEvents)]).toEqual(['auth']);
    expect([...prefixes(templateEvents)]).toEqual(['template']);
    expect([...prefixes(centralTemplateEvents)]).toEqual(['central_template']);
    expect([...prefixes(aiEvents)].sort()).toEqual(['export', 'minutes']);
    expect([...prefixes(botEvents)]).toEqual(['bot']);
    expect([...prefixes(meetingEvents)]).toEqual(['meeting']);
    expect([...prefixes(auditEvents)]).toEqual(['audit']);
  });

  it('allows the browser to report only meeting.*', () => {
    const clientTypes = EVENT_TYPES.filter((t) => (EVENT_CATALOGUE[t].sources as readonly string[]).includes('client'));
    expect([...clientTypes].sort()).toEqual(Object.keys(meetingEvents).sort());
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
    const details = { templateSource: 'central', templateVersion: 7, durationMs: 10, segmentCount: 2 };
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

describe('Phase 1 admin call sites still validate', () => {
  it('accepts every details shape access-admin / bootstrap / directory-match pass today', () => {
    const cases: Array<[EventType, Record<string, unknown>]> = [
      ['access.role_assign', { roleKey: 'tt-logleser', scopeOrgUnitUuid: null, includeDescendants: true }],
      ['access.role_assign', { roleKey: 'tt-administrator', bootstrap: true }],
      ['access.role_revoke', { roleKey: 'tt-logleser', scopeOrgUnitUuid: UUID_B }],
      ['access.org_unit_update', { nameChanged: true, parentChanged: false }],
      ['access.user_create', { source: 'local' }],
      ['access.user_link', { via: 'userid-claim', automatic: true }],
      ['access.org_unit_create', {}],
      ['access.member_add', {}],
    ];
    for (const [type, details] of cases) {
      expect(validateEvent(eventFor(type, details)), `${type} ${JSON.stringify(details)}`).toMatchObject({ ok: true });
    }
  });
});

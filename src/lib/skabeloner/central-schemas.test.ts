import { describe, expect, it } from 'vitest';
import {
  CHANGE_NOTE_MESSAGE,
  NUL_MESSAGE,
  centralStateChangeSchema,
  centralTargetsSchema,
  changeNoteSchema,
  createCentralTemplateSchema,
  updateCentralTemplateSchema,
} from './central-schemas';

const UNIT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNIT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOTE = 'Første version til hele afdelingen';

const validCreate = { ownerOrgUnitUuid: UNIT_A, name: 'Dialogmøde', prompt: 'Skriv kort.', changeNote: NOTE };

describe('changeNoteSchema', () => {
  it('trims, then requires at least 10 characters, with the Danish message', () => {
    expect(changeNoteSchema.parse('   ti tegn !!   ')).toBe('ti tegn !!');
    for (const bad of ['', '         ', '123456789', '  123456789  ', '\n\t\n\t\n\t\n\t\n\t']) {
      const r = changeNoteSchema.safeParse(bad);
      expect(r.success, JSON.stringify(bad)).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toBe(CHANGE_NOTE_MESSAGE);
    }
    expect(CHANGE_NOTE_MESSAGE).toBe('Beskriv ændringen (mindst 10 tegn)');
  });

  it('counts characters, not UTF-16 units (5 emoji are 5 characters to Postgres)', () => {
    expect(changeNoteSchema.safeParse('😀😀😀😀😀').success).toBe(false);
    expect(changeNoteSchema.safeParse('😀'.repeat(10)).success).toBe(true);
  });

  it('does not accept a note made only of invisible characters', () => {
    // Each of these renders as nothing, but is not whitespace to String.prototype.trim.
    const invisible: Record<string, string> = {
      zeroWidthSpace: '\u200b',
      zeroWidthJoiner: '\u200d',
      wordJoiner: '\u2060',
      byteOrderMark: '\ufeff',
      softHyphen: '\u00ad',
      hangulFiller: '\u3164',
      hangulChoseongFiller: '\u115f',
      brailleBlank: '\u2800',
      halfwidthHangulFiller: '\uffa0',
      control: '\u0007',
    };
    for (const [name, ch] of Object.entries(invisible)) {
      const r = changeNoteSchema.safeParse(ch.repeat(12));
      expect(r.success, name).toBe(false);
      if (!r.success) expect(r.error.issues[0].message, name).toBe(CHANGE_NOTE_MESSAGE);
    }
  });

  it('counts only visible characters: invisible padding cannot top up a short note', () => {
    expect(changeNoteSchema.safeParse('kort' + '\u200b'.repeat(20)).success).toBe(false);
    expect(changeNoteSchema.safeParse('\u200b123456789\u200b\u00ad').success).toBe(false);
  });

  it('stores the normalised note (invisible characters removed, line breaks kept)', () => {
    expect(changeNoteSchema.parse('Rettet\u200b tone\u00ad i afsnit 2')).toBe('Rettet tone i afsnit 2');
    expect(changeNoteSchema.parse('Linje et\r\nLinje to\tende')).toBe('Linje et\r\nLinje to\tende');
    expect(changeNoteSchema.parse('Første version til hele afdelingen')).toBe(NOTE);
  });

  it('rejects NUL on the raw value before any stripping', () => {
    const r = changeNoteSchema.safeParse('Rettet tone i afsnit 2\u0000');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe(NUL_MESSAGE);
  });

  it('bounds the raw input before stripping it', () => {
    expect(changeNoteSchema.safeParse('\u200b'.repeat(100_000)).success).toBe(false);
  });

  it('caps at 2000 characters and rejects non-strings and missing values', () => {
    expect(changeNoteSchema.safeParse('a'.repeat(2000)).success).toBe(true);
    expect(changeNoteSchema.safeParse('a'.repeat(2001)).success).toBe(false);
    expect(changeNoteSchema.safeParse(undefined).success).toBe(false);
    expect(changeNoteSchema.safeParse(12345678901).success).toBe(false);
  });
});

describe('centralTargetsSchema', () => {
  it('deduplicates by unit (first wins, case-insensitive) and defaults includeDescendants to true', () => {
    const out = centralTargetsSchema.parse([
      { orgUnitUuid: UNIT_A },
      { orgUnitUuid: UNIT_B, includeDescendants: false },
      { orgUnitUuid: UNIT_A.toUpperCase(), includeDescendants: false },
    ]);
    expect(out).toEqual([
      { orgUnitUuid: UNIT_A, includeDescendants: true },
      { orgUnitUuid: UNIT_B, includeDescendants: false },
    ]);
  });

  it('rejects malformed uuids, unknown keys and more than 200 targets', () => {
    expect(centralTargetsSchema.safeParse([{ orgUnitUuid: 'not-a-uuid' }]).success).toBe(false);
    expect(centralTargetsSchema.safeParse([{ orgUnitUuid: UNIT_A, extra: 1 }]).success).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => ({
      orgUnitUuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    expect(centralTargetsSchema.safeParse(many).success).toBe(false);
    expect(centralTargetsSchema.safeParse(many.slice(0, 200)).success).toBe(true);
  });
});

describe('createCentralTemplateSchema', () => {
  it('applies the documented defaults: nothing user-editable, no recipients', () => {
    const out = createCentralTemplateSchema.parse(validCreate);
    expect(out).toMatchObject({
      description: '',
      includeDeltagere: false,
      includeBeslutningspunkter: false,
      includeDagsorden: false,
      includeDato: false,
      allowUserInstruction: false,
      allowToggleOverrides: false,
      targets: [],
    });
  });

  it('is strict and enforces the content caps', () => {
    expect(createCentralTemplateSchema.safeParse({ ...validCreate, status: 'archived' }).success).toBe(false);
    expect(createCentralTemplateSchema.safeParse({ ...validCreate, currentVersion: 9 }).success).toBe(false);
    expect(createCentralTemplateSchema.safeParse({ ...validCreate, name: '   ' }).success).toBe(false);
    expect(createCentralTemplateSchema.safeParse({ ...validCreate, name: 'a'.repeat(121) }).success).toBe(false);
    expect(createCentralTemplateSchema.safeParse({ ...validCreate, name: 'a'.repeat(120) }).success).toBe(true);
    expect(createCentralTemplateSchema.safeParse({ ...validCreate, description: 'a'.repeat(1001) }).success).toBe(false);
    expect(createCentralTemplateSchema.safeParse({ ...validCreate, prompt: ' ' }).success).toBe(false);
    expect(createCentralTemplateSchema.safeParse({ ...validCreate, prompt: 'a'.repeat(20001) }).success).toBe(false);
    expect(createCentralTemplateSchema.safeParse({ ...validCreate, prompt: 'a'.repeat(20000) }).success).toBe(true);
  });

  it('requires the owner unit (a uuid) and a change note', () => {
    const { changeNote: _n, ...noNote } = validCreate;
    expect(createCentralTemplateSchema.safeParse(noNote).success).toBe(false);
    expect(createCentralTemplateSchema.safeParse({ ...validCreate, ownerOrgUnitUuid: 'x' }).success).toBe(false);
    expect(createCentralTemplateSchema.parse({ ...validCreate, ownerOrgUnitUuid: UNIT_A.toUpperCase() }).ownerOrgUnitUuid).toBe(UNIT_A);
  });
});

describe('updateCentralTemplateSchema', () => {
  it('needs baseVersion and changeNote, takes partial content, and is strict', () => {
    expect(updateCentralTemplateSchema.safeParse({ baseVersion: 1, changeNote: NOTE, prompt: 'Ny' }).success).toBe(true);
    expect(updateCentralTemplateSchema.safeParse({ changeNote: NOTE, prompt: 'Ny' }).success).toBe(false);
    expect(updateCentralTemplateSchema.safeParse({ baseVersion: 1, prompt: 'Ny' }).success).toBe(false);
    expect(updateCentralTemplateSchema.safeParse({ baseVersion: 0, changeNote: NOTE }).success).toBe(false);
    expect(updateCentralTemplateSchema.safeParse({ baseVersion: 1.5, changeNote: NOTE }).success).toBe(false);
    expect(updateCentralTemplateSchema.safeParse({ baseVersion: 1, changeNote: NOTE, ownerOrgUnitUuid: UNIT_B }).success).toBe(false);
    expect(updateCentralTemplateSchema.safeParse({ baseVersion: 1, changeNote: NOTE, status: 'archived' }).success).toBe(false);
  });

  it('leaves absent fields undefined (a partial update must not reset flags)', () => {
    const out = updateCentralTemplateSchema.parse({ baseVersion: 3, changeNote: NOTE, name: 'Nyt navn' });
    expect(out.includeDato).toBeUndefined();
    expect(out.allowUserInstruction).toBeUndefined();
    expect(out.targets).toBeUndefined();
  });
});

describe('centralStateChangeSchema', () => {
  it('requires baseVersion and a change note, nothing else', () => {
    expect(centralStateChangeSchema.safeParse({ baseVersion: 2, changeNote: NOTE }).success).toBe(true);
    expect(centralStateChangeSchema.safeParse({ baseVersion: 2, changeNote: 'kort' }).success).toBe(false);
    expect(centralStateChangeSchema.safeParse({ baseVersion: 2, changeNote: NOTE, name: 'x' }).success).toBe(false);
  });
});

describe('NUL characters', () => {
  it('are rejected in name, description, prompt and changeNote (Postgres cannot store U+0000)', () => {
    for (const field of ['name', 'description', 'prompt', 'changeNote'] as const) {
      const value = field === 'changeNote' ? 'Første version\u0000 ok' : 'a\u0000b';
      const r = createCentralTemplateSchema.safeParse({ ...validCreate, [field]: value });
      expect(r.success, field).toBe(false);
      if (!r.success) expect(r.error.issues[0].path[0]).toBe(field);
    }
    expect(
      updateCentralTemplateSchema.safeParse({ baseVersion: 1, changeNote: NOTE, prompt: 'x\u0000' }).success,
    ).toBe(false);
    expect(centralStateChangeSchema.safeParse({ baseVersion: 1, changeNote: 'Årsag\u0000 til arkivering' }).success).toBe(false);
  });
});

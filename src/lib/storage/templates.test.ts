import { describe, it, expect, beforeAll } from 'vitest';
import { DEFAULT_TEMPLATES, getTemplates } from './templates';
import type { Template, TemplateSectionDef } from '@/types';

// ─── DEFAULT_TEMPLATES shape ──────────────────────────────────────────────────

describe('DEFAULT_TEMPLATES', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(DEFAULT_TEMPLATES)).toBe(true);
    expect(DEFAULT_TEMPLATES.length).toBeGreaterThan(0);
  });

  it('contains exactly one isDefault template', () => {
    const defaults = DEFAULT_TEMPLATES.filter((t) => t.isDefault);
    expect(defaults).toHaveLength(1);
  });

  it('the single default template is "tmpl-bestyrelsesmøde"', () => {
    const def = DEFAULT_TEMPLATES.find((t) => t.isDefault);
    expect(def?.id).toBe('tmpl-bestyrelsesmøde');
  });

  it('all templates have a non-empty string id', () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(typeof t.id).toBe('string');
      expect(t.id.length).toBeGreaterThan(0);
    }
  });

  it('all template ids are unique', () => {
    const ids = DEFAULT_TEMPLATES.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all templates have a non-empty name', () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
    }
  });

  it('all templates have a non-empty description', () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it('all templates have isDefault as a boolean', () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(typeof t.isDefault).toBe('boolean');
    }
  });

  it('all templates have a structure object with a sections array', () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(t.structure).toBeDefined();
      expect(Array.isArray(t.structure.sections)).toBe(true);
      expect(t.structure.sections.length).toBeGreaterThan(0);
    }
  });
});

// ─── Section definitions ──────────────────────────────────────────────────────

describe('DEFAULT_TEMPLATES section definitions', () => {
  it('every section has a non-empty string key', () => {
    for (const t of DEFAULT_TEMPLATES) {
      for (const s of t.structure.sections) {
        expect(typeof s.key).toBe('string');
        expect(s.key.length).toBeGreaterThan(0);
      }
    }
  });

  it('every section has a non-empty string label', () => {
    for (const t of DEFAULT_TEMPLATES) {
      for (const s of t.structure.sections) {
        expect(typeof s.label).toBe('string');
        expect(s.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('every section has a boolean required field', () => {
    for (const t of DEFAULT_TEMPLATES) {
      for (const s of t.structure.sections) {
        expect(typeof s.required).toBe('boolean');
      }
    }
  });

  it('section keys within a single template are unique', () => {
    for (const t of DEFAULT_TEMPLATES) {
      const keys = t.structure.sections.map((s) => s.key);
      const unique = new Set(keys);
      expect(unique.size).toBe(keys.length);
    }
  });

  it('every template has at least one required section', () => {
    for (const t of DEFAULT_TEMPLATES) {
      const requiredSections = t.structure.sections.filter((s) => s.required);
      expect(requiredSections.length).toBeGreaterThan(0);
    }
  });
});

// ─── Individual template content ──────────────────────────────────────────────

describe('tmpl-bestyrelsesmøde template', () => {
  let tmpl: Template;

  beforeAll(() => {
    tmpl = DEFAULT_TEMPLATES.find((t) => t.id === 'tmpl-bestyrelsesmøde')!;
  });

  it('exists in DEFAULT_TEMPLATES', () => {
    expect(tmpl).toBeDefined();
  });

  it('has name "Bestyrelsesmøde"', () => {
    expect(tmpl.name).toBe('Bestyrelsesmøde');
  });

  it('has isDefault true', () => {
    expect(tmpl.isDefault).toBe(true);
  });

  it('has 5 sections', () => {
    expect(tmpl.structure.sections).toHaveLength(5);
  });

  it('contains section key "deltagere"', () => {
    const keys = tmpl.structure.sections.map((s) => s.key);
    expect(keys).toContain('deltagere');
  });

  it('contains section key "dagsorden"', () => {
    const keys = tmpl.structure.sections.map((s) => s.key);
    expect(keys).toContain('dagsorden');
  });

  it('contains section key "beslutninger"', () => {
    const keys = tmpl.structure.sections.map((s) => s.key);
    expect(keys).toContain('beslutninger');
  });

  it('contains section key "handlepunkter"', () => {
    const keys = tmpl.structure.sections.map((s) => s.key);
    expect(keys).toContain('handlepunkter');
  });

  it('contains section key "næste_møde"', () => {
    const keys = tmpl.structure.sections.map((s) => s.key);
    expect(keys).toContain('næste_møde');
  });

  it('"handlepunkter" is not required', () => {
    const s = tmpl.structure.sections.find((s) => s.key === 'handlepunkter')!;
    expect(s.required).toBe(false);
  });

  it('"næste_møde" is not required', () => {
    const s = tmpl.structure.sections.find((s) => s.key === 'næste_møde')!;
    expect(s.required).toBe(false);
  });

  it('"deltagere" is required', () => {
    const s = tmpl.structure.sections.find((s) => s.key === 'deltagere')!;
    expect(s.required).toBe(true);
  });

  it('"beslutninger" is required', () => {
    const s = tmpl.structure.sections.find((s) => s.key === 'beslutninger')!;
    expect(s.required).toBe(true);
  });
});

describe('tmpl-personalemøde template', () => {
  let tmpl: Template;

  beforeAll(() => {
    tmpl = DEFAULT_TEMPLATES.find((t) => t.id === 'tmpl-personalemøde')!;
  });

  it('exists in DEFAULT_TEMPLATES', () => {
    expect(tmpl).toBeDefined();
  });

  it('has isDefault false', () => {
    expect(tmpl.isDefault).toBe(false);
  });

  it('has 4 sections', () => {
    expect(tmpl.structure.sections).toHaveLength(4);
  });

  it('contains section key "aftaler"', () => {
    const keys = tmpl.structure.sections.map((s) => s.key);
    expect(keys).toContain('aftaler');
  });

  it('"aftaler" is required', () => {
    const s = tmpl.structure.sections.find((s) => s.key === 'aftaler')!;
    expect(s.required).toBe(true);
  });
});

describe('tmpl-forældresamtale template', () => {
  let tmpl: Template;

  beforeAll(() => {
    tmpl = DEFAULT_TEMPLATES.find((t) => t.id === 'tmpl-forældresamtale')!;
  });

  it('exists in DEFAULT_TEMPLATES', () => {
    expect(tmpl).toBeDefined();
  });

  it('has isDefault false', () => {
    expect(tmpl.isDefault).toBe(false);
  });

  it('has 4 sections', () => {
    expect(tmpl.structure.sections).toHaveLength(4);
  });

  it('all 4 sections are required', () => {
    const required = tmpl.structure.sections.filter((s) => s.required);
    expect(required).toHaveLength(4);
  });

  it('contains section key "fagligt"', () => {
    const keys = tmpl.structure.sections.map((s) => s.key);
    expect(keys).toContain('fagligt');
  });

  it('contains section key "trivsel"', () => {
    const keys = tmpl.structure.sections.map((s) => s.key);
    expect(keys).toContain('trivsel');
  });
});

describe('tmpl-projektmøde template', () => {
  let tmpl: Template;

  beforeAll(() => {
    tmpl = DEFAULT_TEMPLATES.find((t) => t.id === 'tmpl-projektmøde')!;
  });

  it('exists in DEFAULT_TEMPLATES', () => {
    expect(tmpl).toBeDefined();
  });

  it('has isDefault false', () => {
    expect(tmpl.isDefault).toBe(false);
  });

  it('has 5 sections', () => {
    expect(tmpl.structure.sections).toHaveLength(5);
  });

  it('contains section key "opgaver"', () => {
    const keys = tmpl.structure.sections.map((s) => s.key);
    expect(keys).toContain('opgaver');
  });

  it('contains section key "status"', () => {
    const keys = tmpl.structure.sections.map((s) => s.key);
    expect(keys).toContain('status');
  });

  it('"næste_møde" is optional', () => {
    const s = tmpl.structure.sections.find((s) => s.key === 'næste_møde')!;
    expect(s.required).toBe(false);
  });
});

// ─── getTemplates() ───────────────────────────────────────────────────────────

describe('getTemplates', () => {
  it('returns the same array as DEFAULT_TEMPLATES', () => {
    expect(getTemplates()).toBe(DEFAULT_TEMPLATES);
  });

  it('returns all templates', () => {
    expect(getTemplates()).toHaveLength(DEFAULT_TEMPLATES.length);
  });

  it('returns an array', () => {
    expect(Array.isArray(getTemplates())).toBe(true);
  });

  it('called twice returns the same reference', () => {
    expect(getTemplates()).toBe(getTemplates());
  });

  it('returned array contains templates with id, name, description, structure, isDefault', () => {
    const templates = getTemplates();
    for (const t of templates) {
      expect(t).toHaveProperty('id');
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('description');
      expect(t).toHaveProperty('structure');
      expect(t).toHaveProperty('isDefault');
    }
  });

  it('getTemplates() result contains exactly one default template', () => {
    const defaults = getTemplates().filter((t) => t.isDefault);
    expect(defaults).toHaveLength(1);
  });

  it('getTemplates() result contains template with id "tmpl-bestyrelsesmøde"', () => {
    const ids = getTemplates().map((t) => t.id);
    expect(ids).toContain('tmpl-bestyrelsesmøde');
  });

  it('getTemplates() result contains template with id "tmpl-personalemøde"', () => {
    const ids = getTemplates().map((t) => t.id);
    expect(ids).toContain('tmpl-personalemøde');
  });

  it('getTemplates() result contains template with id "tmpl-forældresamtale"', () => {
    const ids = getTemplates().map((t) => t.id);
    expect(ids).toContain('tmpl-forældresamtale');
  });

  it('getTemplates() result contains template with id "tmpl-projektmøde"', () => {
    const ids = getTemplates().map((t) => t.id);
    expect(ids).toContain('tmpl-projektmøde');
  });
});

// ─── Section label well-formedness ───────────────────────────────────────────

describe('section labels are well-formed', () => {
  it('labels are non-empty trimmed strings (no leading/trailing whitespace)', () => {
    for (const t of DEFAULT_TEMPLATES) {
      for (const s of t.structure.sections) {
        expect(s.label).toBe(s.label.trim());
      }
    }
  });

  it('keys are non-empty and contain no spaces', () => {
    for (const t of DEFAULT_TEMPLATES) {
      for (const s of t.structure.sections) {
        expect(s.key).not.toContain(' ');
      }
    }
  });

  it('keys are lowercase strings', () => {
    for (const t of DEFAULT_TEMPLATES) {
      for (const s of t.structure.sections) {
        expect(s.key).toBe(s.key.toLowerCase());
      }
    }
  });

  it('"Deltagere" section has label "Deltagere" in bestyrelsesmøde template', () => {
    const tmpl = DEFAULT_TEMPLATES.find((t) => t.id === 'tmpl-bestyrelsesmøde')!;
    const section = tmpl.structure.sections.find((s) => s.key === 'deltagere')!;
    expect(section.label).toBe('Deltagere');
  });

  it('"beslutninger" section has label "Beslutninger" in bestyrelsesmøde template', () => {
    const tmpl = DEFAULT_TEMPLATES.find((t) => t.id === 'tmpl-bestyrelsesmøde')!;
    const section = tmpl.structure.sections.find((s) => s.key === 'beslutninger')!;
    expect(section.label).toBe('Beslutninger');
  });
});

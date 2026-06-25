import { describe, it, expect } from 'vitest';
import {
  encodeSkabelonCode,
  decodeSkabelonCode,
  extractImportToken,
  type ShareableSkabelon,
} from './share-code';

const SAMPLE: ShareableSkabelon = {
  name: 'Bestyrelsesmøde',
  description: 'Referat med beslutninger og ansvarlige — æøå',
  prompt: 'Skriv et kort referat på dansk.\nFremhæv beslutninger.',
  includeDeltagere: true,
  includeBeslutningspunkter: true,
  includeDagsorden: false,
  includeDato: true,
};

describe('skabelon share-code', () => {
  it('round-trips a template through encode/decode', () => {
    const code = encodeSkabelonCode(SAMPLE);
    expect(code.startsWith('skab1_')).toBe(true);
    expect(decodeSkabelonCode(code)).toEqual(SAMPLE);
  });

  it('preserves Danish characters and newlines', () => {
    const decoded = decodeSkabelonCode(encodeSkabelonCode(SAMPLE));
    expect(decoded?.description).toContain('æøå');
    expect(decoded?.prompt).toContain('\n');
  });

  it('tolerates surrounding whitespace', () => {
    const code = encodeSkabelonCode(SAMPLE);
    expect(decodeSkabelonCode(`  \n${code}\n `)).toEqual(SAMPLE);
  });

  it('returns null for non-codes', () => {
    expect(decodeSkabelonCode('hello world')).toBeNull();
    expect(decodeSkabelonCode('')).toBeNull();
    expect(decodeSkabelonCode('skab1_not-valid-base64-$$$')).toBeNull();
  });

  it('extracts a token from an import link', () => {
    expect(
      extractImportToken('https://app.example.com/skabeloner/import/abc-123'),
    ).toBe('abc-123');
    expect(
      extractImportToken('https://app.example.com/skabeloner/import/abc-123?x=1'),
    ).toBe('abc-123');
    expect(extractImportToken('just some text')).toBeNull();
  });
});

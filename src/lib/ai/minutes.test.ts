import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockComplete = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mockComplete } };
  },
}));

import { generateReferatBody, buildSkabelonInstruction, SkabelonSpec } from './minutes';
import type { TranscriptSegment } from '@/types';

const sampleSegments: TranscriptSegment[] = [
  { speaker: 'Taler 1', start: 0, end: 5, text: 'Vi åbner mødet.' },
  { speaker: 'Taler 2', start: 6, end: 10, text: 'Første punkt på dagsordenen.' },
];

const baseSpec: SkabelonSpec = {
  prompt: 'Lav et kortfattet referat.',
  includeDeltagere: false,
  includeBeslutningspunkter: false,
  includeDagsorden: false,
  includeDato: false,
};

function openaiResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

// ─── buildSkabelonInstruction ─────────────────────────────────────────────────

describe('buildSkabelonInstruction', () => {
  it('includes the base prompt', () => {
    const out = buildSkabelonInstruction(baseSpec);
    expect(out).toContain('Lav et kortfattet referat.');
  });

  it('injects the three categories when toggled on', () => {
    const out = buildSkabelonInstruction(
      { ...baseSpec, includeDeltagere: true, includeBeslutningspunkter: true, includeDagsorden: true },
      ['Anna', 'Bjørn'],
    );
    expect(out).toContain('Deltagere');
    expect(out).toContain('Beslutningspunkter');
    expect(out).toContain('Dagsorden');
    expect(out).toContain('Anna, Bjørn');
  });

  it('lists participants even without the Deltagere category', () => {
    const out = buildSkabelonInstruction(baseSpec, ['Anna']);
    expect(out).toContain('Anna');
  });

  it('appends the custom prompt', () => {
    const out = buildSkabelonInstruction(baseSpec, [], 'Fokus på handlinger');
    expect(out).toContain('Fokus på handlinger');
  });

  it('omits categories that are toggled off', () => {
    const out = buildSkabelonInstruction({ ...baseSpec, includeDagsorden: true });
    expect(out).toContain('Dagsorden');
    expect(out).not.toContain('Beslutningspunkter');
  });

  it('injects the formatted meeting date when Dato is on', () => {
    const out = buildSkabelonInstruction(
      { ...baseSpec, includeDato: true },
      undefined,
      undefined,
      '2026-06-16T10:00:00.000Z',
    );
    expect(out).toContain('16. juni 2026');
  });

  it('falls back to a Dato section when no date is supplied', () => {
    const out = buildSkabelonInstruction({ ...baseSpec, includeDato: true });
    expect(out).toContain('Dato');
  });
});

// ─── generateReferatBody ──────────────────────────────────────────────────────

describe('generateReferatBody', () => {
  beforeEach(() => mockComplete.mockReset());

  it('returns the markdown body from the OpenAI response', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('## Referat\n\nMødet blev åbnet.'));

    const result = await generateReferatBody(sampleSegments, baseSpec);

    expect(result.body).toBe('## Referat\n\nMødet blev åbnet.');
  });

  it('strips an accidental markdown code fence', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('```markdown\n## Referat\n\nIndhold.\n```'));

    const result = await generateReferatBody(sampleSegments, baseSpec);

    expect(result.body).toBe('## Referat\n\nIndhold.');
  });

  it('includes the transcript text in the prompt', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('referat'));

    await generateReferatBody(sampleSegments, baseSpec);

    const userContent = mockComplete.mock.calls[0][0].messages[1].content as string;
    expect(userContent).toContain('Vi åbner mødet.');
  });

  it('includes formatted timestamps in the prompt', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('referat'));

    await generateReferatBody([{ speaker: 'Taler 1', start: 65, end: 70, text: 'Hej' }], baseSpec);

    const userContent = mockComplete.mock.calls[0][0].messages[1].content as string;
    expect(userContent).toContain('1:05'); // 65 seconds
  });

  it('feeds the built instruction into the prompt', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('referat'));

    await generateReferatBody(sampleSegments, { ...baseSpec, includeDagsorden: true });

    const userContent = mockComplete.mock.calls[0][0].messages[1].content as string;
    expect(userContent).toContain('Dagsorden');
  });

  it('uses gpt-4o', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('referat'));

    await generateReferatBody(sampleSegments, baseSpec);

    expect(mockComplete.mock.calls[0][0].model).toBe('gpt-4o');
  });
});

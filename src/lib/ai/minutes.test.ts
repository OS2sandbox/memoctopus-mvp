import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockComplete = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mockComplete } };
  },
}));

import {
  generateReferatBody,
  buildSkabelonInstruction,
  mergeConsecutiveSpeakerTurns,
  SkabelonSpec,
} from './minutes';
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

  it('does not inject the date into the body — the Dato tag drives the document header instead', () => {
    const out = buildSkabelonInstruction({ ...baseSpec, includeDato: true });
    expect(out).not.toContain('Dato');
    expect(out).not.toContain('dato');
    // Other categories are unaffected.
    const withAgenda = buildSkabelonInstruction({ ...baseSpec, includeDato: true, includeDagsorden: true });
    expect(withAgenda).toContain('Dagsorden');
  });
});

// ─── generateReferatBody ──────────────────────────────────────────────────────

describe('generateReferatBody', () => {
  // A key is configured, so the LLM selector targets hosted OpenAI (gpt-4o).
  beforeEach(() => { process.env.OPENAI_API_KEY = 'sk-test'; mockComplete.mockReset(); });

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

// ─── Speaker-turn merging ─────────────────────────────────────────────────────

describe('mergeConsecutiveSpeakerTurns', () => {
  // Without this, mock.calls[0] is a leftover call from an earlier describe and the
  // prompt assertion below passes even with merging disabled.
  beforeEach(() => {
    mockComplete.mockReset();
    mockComplete.mockResolvedValue(openaiResponse('Referat'));
  });

  it('collapses a run of segments from one speaker into a single turn', () => {
    const merged = mergeConsecutiveSpeakerTurns([
      { speaker: 'Taler 1', start: 0, end: 2, text: 'Vi åbner' },
      { speaker: 'Taler 1', start: 2, end: 4, text: 'mødet nu.' },
      { speaker: 'Taler 2', start: 5, end: 7, text: 'Godt.' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe('Vi åbner mødet nu.');
    expect(merged[1].text).toBe('Godt.');
  });

  it('keeps the first start and the last end so timestamps still bracket the turn', () => {
    const merged = mergeConsecutiveSpeakerTurns([
      { speaker: 'Taler 1', start: 3, end: 5, text: 'a' },
      { speaker: 'Taler 1', start: 5, end: 9, text: 'b' },
    ]);
    expect(merged[0].start).toBe(3);
    expect(merged[0].end).toBe(9);
  });

  it('does not merge across a different speaker', () => {
    const merged = mergeConsecutiveSpeakerTurns([
      { speaker: 'Taler 1', start: 0, end: 1, text: 'a' },
      { speaker: 'Taler 2', start: 1, end: 2, text: 'b' },
      { speaker: 'Taler 1', start: 2, end: 3, text: 'c' },
    ]);
    expect(merged.map((m) => m.text)).toEqual(['a', 'b', 'c']);
  });

  it('never mutates the caller’s segments', () => {
    const input: TranscriptSegment[] = [
      { speaker: 'Taler 1', start: 0, end: 1, text: 'a' },
      { speaker: 'Taler 1', start: 1, end: 2, text: 'b' },
    ];
    mergeConsecutiveSpeakerTurns(input);
    expect(input[0].text).toBe('a');
    expect(input[0].end).toBe(1);
  });

  it('handles an empty transcript', () => {
    expect(mergeConsecutiveSpeakerTurns([])).toEqual([]);
  });

  it('cuts the repeated speaker labels out of the prompt', async () => {
    mockComplete.mockResolvedValue(openaiResponse('Referat'));
    // 40 consecutive segments from one speaker: one label instead of forty.
    const chatty: TranscriptSegment[] = Array.from({ length: 40 }, (_, i) => ({
      speaker: 'Taler 1', start: i, end: i + 1, text: 'ord',
    }));
    await generateReferatBody(chatty, baseSpec);
    const prompt = mockComplete.mock.calls[0][0].messages[1].content as string;
    expect((prompt.match(/\[Taler 1\]/g) ?? []).length).toBe(1);
  });
});

// ─── Context-window budgeting ─────────────────────────────────────────────────

describe('generateReferatBody — prompt sizing', () => {
  const envKeys = [
    'LLM_CONTEXT_TOKENS', 'LLM_MAX_OUTPUT_TOKENS', 'LLM_PROMPT_RESERVE_TOKENS',
    'LLM_CHARS_PER_TOKEN', 'LLM_CHAPTER_SPLIT_CHARS', 'LLM_CHAPTER_SUMMARY_MAX_TOKENS',
  ];

  beforeEach(() => {
    mockComplete.mockReset();
    mockComplete.mockResolvedValue(openaiResponse('Referat'));
    for (const k of envKeys) delete process.env[k];
  });

  // One segment per speaker alternation, so merging can't collapse it away.
  function longTranscript(chars: number): TranscriptSegment[] {
    const n = Math.ceil(chars / 20);
    return Array.from({ length: n }, (_, i) => ({
      speaker: `Taler ${(i % 2) + 1}`, start: i, end: i + 1, text: 'x'.repeat(18),
    }));
  }

  it('caps the referat output with max_tokens', async () => {
    process.env.LLM_MAX_OUTPUT_TOKENS = '1234';
    await generateReferatBody(sampleSegments, baseSpec);
    expect(mockComplete.mock.calls[0][0].max_tokens).toBe(1234);
  });

  it('defaults max_tokens rather than leaving output uncapped', async () => {
    await generateReferatBody(sampleSegments, baseSpec);
    expect(mockComplete.mock.calls[0][0].max_tokens).toBe(2000);
  });

  it('truncates an unchaptered transcript that exceeds the window', async () => {
    // 4000 usable tokens x 2 chars/token = 8000 chars of budget.
    process.env.LLM_CONTEXT_TOKENS = '5000';
    process.env.LLM_MAX_OUTPUT_TOKENS = '500';
    process.env.LLM_PROMPT_RESERVE_TOKENS = '500';
    process.env.LLM_CHARS_PER_TOKEN = '2';

    await generateReferatBody(longTranscript(40_000), baseSpec);
    const prompt = mockComplete.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain('forkortet');
    // The transcript portion must respect the budget, not the raw 40k.
    expect(prompt.length).toBeLessThan(12_000);
  });

  it('leaves a transcript that fits completely untouched', async () => {
    await generateReferatBody(sampleSegments, baseSpec);
    const prompt = mockComplete.mock.calls[0][0].messages[1].content as string;
    expect(prompt).not.toContain('forkortet');
    expect(prompt).toContain('Vi åbner mødet.');
  });

  it('splits by chapter once the transcript passes the configured threshold', async () => {
    process.env.LLM_CHAPTER_SPLIT_CHARS = '500';
    const transcript = longTranscript(2_000);
    const chapters = [
      { title: 'Del 1', segmentIndices: transcript.map((_, i) => i).slice(0, 50) },
      { title: 'Del 2', segmentIndices: transcript.map((_, i) => i).slice(50) },
    ];
    await generateReferatBody(transcript, baseSpec, undefined, chapters as never);
    // Two chapter summaries plus the referat itself.
    expect(mockComplete.mock.calls.length).toBe(3);
  });

  it('splits by chapter when the window is too small, even under the char threshold', async () => {
    // Budget of 200 chars is far below the 20k default split threshold.
    process.env.LLM_CONTEXT_TOKENS = '300';
    process.env.LLM_MAX_OUTPUT_TOKENS = '50';
    process.env.LLM_PROMPT_RESERVE_TOKENS = '50';
    process.env.LLM_CHARS_PER_TOKEN = '1';

    const transcript = longTranscript(2_000);
    const chapters = [
      { title: 'Del 1', segmentIndices: transcript.map((_, i) => i).slice(0, 50) },
      { title: 'Del 2', segmentIndices: transcript.map((_, i) => i).slice(50) },
    ];
    await generateReferatBody(transcript, baseSpec, undefined, chapters as never);
    expect(mockComplete.mock.calls.length).toBe(3);
  });

  it('caps chapter summaries with their own max_tokens', async () => {
    process.env.LLM_CHAPTER_SPLIT_CHARS = '500';
    process.env.LLM_CHAPTER_SUMMARY_MAX_TOKENS = '321';
    const transcript = longTranscript(2_000);
    const chapters = [
      { title: 'Del 1', segmentIndices: transcript.map((_, i) => i).slice(0, 50) },
      { title: 'Del 2', segmentIndices: transcript.map((_, i) => i).slice(50) },
    ];
    await generateReferatBody(transcript, baseSpec, undefined, chapters as never);
    expect(mockComplete.mock.calls[0][0].max_tokens).toBe(321);
  });

  it('ignores a non-numeric env value instead of producing a zero budget', async () => {
    process.env.LLM_CONTEXT_TOKENS = 'not-a-number';
    await generateReferatBody(sampleSegments, baseSpec);
    const prompt = mockComplete.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain('Vi åbner mødet.');
    expect(prompt).not.toContain('forkortet');
  });
});

// ─── Budget floor and per-chapter budgeting ───────────────────────────────────

describe('generateReferatBody — degenerate budgets', () => {
  const envKeys = [
    'LLM_CONTEXT_TOKENS', 'LLM_MAX_OUTPUT_TOKENS', 'LLM_PROMPT_RESERVE_TOKENS',
    'LLM_CHARS_PER_TOKEN', 'LLM_CHAPTER_SPLIT_CHARS', 'LLM_CHAPTER_SUMMARY_MAX_TOKENS',
  ];

  beforeEach(async () => {
    mockComplete.mockReset();
    mockComplete.mockResolvedValue(openaiResponse('Referat'));
    for (const k of envKeys) delete process.env[k];
    (await import('./llm-budget')).__resetBudgetWarning();
  });

  it('never sends an empty transcript when the window is configured absurdly small', async () => {
    // Output + reserve exceed the window entirely — a naive budget would be <= 0.
    process.env.LLM_CONTEXT_TOKENS = '100';
    process.env.LLM_MAX_OUTPUT_TOKENS = '2000';
    process.env.LLM_PROMPT_RESERVE_TOKENS = '1000';
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await generateReferatBody(sampleSegments, baseSpec);
    const prompt = mockComplete.mock.calls[0][0].messages[1].content as string;
    // The model must still see the meeting, not just the truncation marker.
    expect(prompt).toContain('Vi åbner mødet.');
  });

  it('warns loudly rather than silently fabricating from nothing', async () => {
    process.env.LLM_CONTEXT_TOKENS = '100';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await generateReferatBody(sampleSegments, baseSpec);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('LLM_CONTEXT_TOKENS'));
  });

  it('budgets each chapter summary, not just the condensed result', async () => {
    process.env.LLM_CHAPTER_SPLIT_CHARS = '100';
    process.env.LLM_CONTEXT_TOKENS = '3000';
    process.env.LLM_MAX_OUTPUT_TOKENS = '500';
    process.env.LLM_PROMPT_RESERVE_TOKENS = '500';
    process.env.LLM_CHARS_PER_TOKEN = '1';   // budget = 2000 chars

    // One enormous chapter: chaptering bounds the number of summaries, not their size.
    const transcript: TranscriptSegment[] = Array.from({ length: 400 }, (_, i) => ({
      speaker: `Taler ${(i % 2) + 1}`, start: i, end: i + 1, text: 'y'.repeat(50),
    }));
    const chapters = [
      { title: 'Stor del', segmentIndices: transcript.map((_, i) => i).slice(0, 399) },
      { title: 'Lille del', segmentIndices: [399] },
    ];
    await generateReferatBody(transcript, baseSpec, undefined, chapters as never);

    const summaryPrompt = mockComplete.mock.calls[0][0].messages[0].content as string;
    expect(summaryPrompt).toContain('forkortet');
    expect(summaryPrompt.length).toBeLessThan(4_000);
  });
});

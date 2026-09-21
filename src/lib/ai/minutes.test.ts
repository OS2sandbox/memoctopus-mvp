import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockComplete = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mockComplete } };
  },
}));

import { generateReferatBody, buildSkabelonInstruction, SkabelonSpec } from './minutes';
import type { TranscriptSegment } from '@/types';
import type { TranscriptChapter } from './chapters';
import {
  MinutesConfigError,
  MinutesTooLongError,
  MinutesTruncatedError,
} from './minutes-errors';

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

// ─── context budget ───────────────────────────────────────────────────────────

// Limits: 8000-token window, 1000 output tokens → a transcript budget of roughly 16k chars
// (the exact figure depends on the prompt's fixed text; tests assert invariants, not it).
describe('generateReferatBody — context budget', () => {
  const ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ENV,
      OPENAI_API_KEY: 'sk-test',
      LLM_CONTEXT_TOKENS: '8000',
      LLM_MAX_OUTPUT_TOKENS: '1000',
    };
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    mockComplete.mockReset();
  });

  afterEach(() => {
    process.env = ENV;
  });

  // Alternating speakers so nothing merges; every line carries a unique LINE-nnnn marker.
  function longTranscript(count: number, charsEach: number): TranscriptSegment[] {
    return Array.from({ length: count }, (_, i) => ({
      speaker: `Taler ${(i % 2) + 1}`,
      start: i * 10,
      end: i * 10 + 9,
      text: `LINE-${String(i).padStart(4, '0')} ${'x'.repeat(charsEach)}`,
    }));
  }

  const lastContent = (call: { messages: { content: string }[] }) =>
    call.messages[call.messages.length - 1].content;
  const isSummaryCall = (call: { messages: { content: string }[] }) =>
    lastContent(call).startsWith('Opsummer');

  function answerSummariesAndReferat() {
    mockComplete.mockImplementation(async (req: { messages: { content: string }[] }) =>
      openaiResponse(isSummaryCall(req) ? '- punkt' : 'REFERAT'),
    );
  }

  it('makes one call with max_tokens when the transcript fits', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('referat'));

    await generateReferatBody(sampleSegments, baseSpec);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockComplete.mock.calls[0][0].max_tokens).toBe(1000);
  });

  it('merges consecutive same-speaker segments into one turn', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('referat'));

    await generateReferatBody(
      [
        { speaker: 'Taler 1', start: 0, end: 2, text: 'Hej' },
        { speaker: 'Taler 1', start: 3, end: 5, text: 'og velkommen' },
        { speaker: 'Taler 2', start: 6, end: 8, text: 'Tak' },
      ],
      baseSpec,
    );

    const userContent = lastContent(mockComplete.mock.calls[0][0]);
    expect(userContent).toContain('[Taler 1] (0:00): Hej og velkommen');
    expect(userContent.match(/\[Taler 1\]/g)).toHaveLength(1);
  });

  it('summarises in parts when the transcript is over budget and there are no chapters', async () => {
    answerSummariesAndReferat();
    const count = 40;

    const result = await generateReferatBody(longTranscript(count, 1000), baseSpec);

    expect(result.body).toBe('REFERAT');
    const calls = mockComplete.mock.calls.map((c) => c[0]);
    const summaryCalls = calls.filter(isSummaryCall);
    expect(summaryCalls.length).toBeGreaterThanOrEqual(3);

    // The referat itself is written last, from summaries only (not raw transcript lines).
    expect(isSummaryCall(calls[calls.length - 1])).toBe(false);
    expect(lastContent(calls[calls.length - 1])).not.toContain('LINE-0000');

    // Budget invariant: no prompt exceeds (context - its own output cap) × 2.5 chars/token.
    for (const c of calls) {
      const promptChars = c.messages.reduce(
        (n: number, m: { content: string }) => n + m.content.length,
        0,
      );
      expect(promptChars).toBeLessThanOrEqual((8000 - c.max_tokens) * 2.5);
    }

    // No content dropped: every transcript line reaches exactly one summary call.
    for (let i = 0; i < count; i++) {
      const marker = `LINE-${String(i).padStart(4, '0')}`;
      expect(summaryCalls.filter((c) => lastContent(c).includes(marker))).toHaveLength(1);
    }
  });

  it('caps summary calls at 1024 output tokens', async () => {
    answerSummariesAndReferat();

    await generateReferatBody(longTranscript(40, 1000), baseSpec);

    const summaryCalls = mockComplete.mock.calls.map((c) => c[0]).filter(isSummaryCall);
    expect(summaryCalls.length).toBeGreaterThan(0); // guard against a vacuous pass
    for (const c of summaryCalls) expect(c.max_tokens).toBe(1024);
  });

  it('runs at most 3 summary calls at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    mockComplete.mockImplementation(async (req: { messages: { content: string }[] }) => {
      if (!isSummaryCall(req)) return openaiResponse('REFERAT');
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return openaiResponse('- punkt');
    });

    await generateReferatBody(longTranscript(100, 1000), baseSpec);

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('splits an oversized chapter into parts', async () => {
    answerSummariesAndReferat();
    const transcript = longTranscript(40, 1000);
    const chapters: TranscriptChapter[] = [
      {
        id: 'ch-0',
        title: 'Stort kapitel',
        summary: '',
        startTime: 0,
        endTime: 390,
        segmentIndices: Array.from({ length: 40 }, (_, i) => i),
      },
      { id: 'ch-1', title: 'Andet', summary: '', startTime: 400, endTime: 410, segmentIndices: [] },
    ];

    await generateReferatBody(transcript, baseSpec, undefined, chapters);

    const summaryCalls = mockComplete.mock.calls.map((c) => c[0]).filter(isSummaryCall);
    expect(summaryCalls.length).toBeGreaterThanOrEqual(3);
    expect(lastContent(summaryCalls[0])).toContain('"Stort kapitel (del 1/');
  });

  it('keeps the per-chapter path for chaptered transcripts over the 20k-character threshold', async () => {
    delete process.env.LLM_CONTEXT_TOKENS; // hosted defaults: 128k window, plenty of budget
    delete process.env.LLM_MAX_OUTPUT_TOKENS;
    answerSummariesAndReferat();
    const transcript = longTranscript(30, 1000); // ~31k chars, over 20k
    const chapters: TranscriptChapter[] = [
      {
        id: 'ch-0', title: 'Kapitel A', summary: '', startTime: 0, endTime: 140,
        segmentIndices: Array.from({ length: 15 }, (_, i) => i),
      },
      {
        id: 'ch-1', title: 'Kapitel B', summary: '', startTime: 150, endTime: 290,
        segmentIndices: Array.from({ length: 15 }, (_, i) => i + 15),
      },
    ];

    await generateReferatBody(transcript, baseSpec, undefined, chapters);

    const calls = mockComplete.mock.calls.map((c) => c[0]);
    expect(calls.filter(isSummaryCall)).toHaveLength(2);
    expect(lastContent(calls[0])).toContain('"Kapitel A"');
    expect(lastContent(calls[1])).toContain('"Kapitel B"');
    expect(isSummaryCall(calls[2])).toBe(false);
  });

  it('throws MinutesTruncatedError when the model hits its output limit', async () => {
    mockComplete.mockResolvedValueOnce({
      choices: [{ message: { content: 'halvt referat' }, finish_reason: 'length' }],
    });

    await expect(generateReferatBody(sampleSegments, baseSpec)).rejects.toBeInstanceOf(
      MinutesTruncatedError,
    );
  });

  it('throws MinutesConfigError when the context window is too small to be usable', async () => {
    process.env.LLM_CONTEXT_TOKENS = '1500';

    await expect(generateReferatBody(sampleSegments, baseSpec)).rejects.toBeInstanceOf(
      MinutesConfigError,
    );
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('throws MinutesTooLongError when summaries never shrink below the budget', async () => {
    mockComplete.mockImplementation(async () => openaiResponse('y'.repeat(20_000)));

    await expect(generateReferatBody(longTranscript(40, 1000), baseSpec)).rejects.toBeInstanceOf(
      MinutesTooLongError,
    );
  });
});

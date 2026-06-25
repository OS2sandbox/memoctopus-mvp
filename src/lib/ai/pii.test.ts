import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockComplete = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mockComplete } };
  },
}));

import { removePii, removePiiFromSegments, detectPiiInSegments } from './pii';

function openaiResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

// ─── removePii ────────────────────────────────────────────────────────────────

describe('removePii', () => {
  // A key is configured, so the LLM selector targets hosted OpenAI (gpt-4o).
  beforeEach(() => { process.env.OPENAI_API_KEY = 'sk-test'; mockComplete.mockReset(); });

  it('returns cleanedText and replacements from a valid response', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          cleanedText: 'Møde med [NAVN] om projektet.',
          replacements: [{ original: 'Lars Jensen', replacement: '[NAVN]', type: 'NAVN' }],
        }),
      ),
    );

    const result = await removePii('Møde med Lars Jensen om projektet.');

    expect(result.cleanedText).toBe('Møde med [NAVN] om projektet.');
    expect(result.replacements).toHaveLength(1);
    expect(result.replacements[0]).toMatchObject({
      original: 'Lars Jensen',
      replacement: '[NAVN]',
      type: 'NAVN',
    });
  });

  it('strips markdown code fences before parsing', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse('```json\n{"cleanedText":"clean","replacements":[]}\n```'),
    );

    const result = await removePii('clean');
    expect(result.cleanedText).toBe('clean');
    expect(result.replacements).toHaveLength(0);
  });

  it('falls back to original text when JSON is invalid', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('not valid json at all'));

    const result = await removePii('original text');
    expect(result.cleanedText).toBe('original text');
    expect(result.replacements).toHaveLength(0);
  });

  it('logs the raw response and bound error on parse failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockComplete.mockResolvedValueOnce(openaiResponse('totally invalid json'));

    await removePii('something');

    expect(errorSpy).toHaveBeenCalledOnce();
    const [label, raw, err] = errorSpy.mock.calls[0];
    expect(label).toBe('[pii] parse failed. raw:');
    expect(raw).toBe('totally invalid json');
    expect(err).toBeInstanceOf(SyntaxError);

    errorSpy.mockRestore();
  });

  it('falls back to original text when response content is empty', async () => {
    mockComplete.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] });

    const result = await removePii('fallback text');
    expect(result.cleanedText).toBe('fallback text');
    expect(result.replacements).toHaveLength(0);
  });

  it('falls back to original text when choices array is empty', async () => {
    mockComplete.mockResolvedValueOnce({ choices: [] });

    const result = await removePii('no choices');
    expect(result.cleanedText).toBe('no choices');
    expect(result.replacements).toHaveLength(0);
  });

  it('handles multiple replacement types', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          cleanedText: '[NAVN] bor på [KONTAKT], tlf. [KONTAKT]',
          replacements: [
            { original: 'Hans', replacement: '[NAVN]', type: 'NAVN' },
            { original: 'Nørrebrogade 1', replacement: '[KONTAKT]', type: 'KONTAKT' },
            { original: '12345678', replacement: '[KONTAKT]', type: 'KONTAKT' },
          ],
        }),
      ),
    );

    const result = await removePii('Hans bor på Nørrebrogade 1, tlf. 12345678');
    expect(result.replacements).toHaveLength(3);
    expect(result.replacements.map((r) => r.type)).toEqual(['NAVN', 'KONTAKT', 'KONTAKT']);
  });

  it('handles empty replacements array', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(JSON.stringify({ cleanedText: 'No PII here.', replacements: [] })),
    );

    const result = await removePii('No PII here.');
    expect(result.replacements).toHaveLength(0);
    expect(result.cleanedText).toBe('No PII here.');
  });

  it('handles CPR-type replacements', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          cleanedText: 'CPR: [CPR]',
          replacements: [{ original: '010101-1234', replacement: '[CPR]', type: 'CPR' }],
        }),
      ),
    );

    const result = await removePii('CPR: 010101-1234');
    expect(result.replacements[0].type).toBe('CPR');
    expect(result.replacements[0].replacement).toBe('[CPR]');
  });

  it('sends the text in the user message to OpenAI', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(JSON.stringify({ cleanedText: 'hello', replacements: [] })),
    );

    await removePii('check this text');

    const call = mockComplete.mock.calls[0][0];
    const userMessage = call.messages[1].content as string;
    expect(userMessage).toContain('check this text');
  });

  it('sends the system prompt as first message', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(JSON.stringify({ cleanedText: 'x', replacements: [] })),
    );

    await removePii('anything');

    const call = mockComplete.mock.calls[0][0];
    expect(call.messages[0].role).toBe('system');
    expect(call.messages[0].content).toContain('GDPR');
  });

  it('uses gpt-4o model', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(JSON.stringify({ cleanedText: 'x', replacements: [] })),
    );

    await removePii('anything');

    const call = mockComplete.mock.calls[0][0];
    expect(call.model).toBe('gpt-4o');
  });
});

// ─── removePiiFromSegments ────────────────────────────────────────────────────

describe('removePiiFromSegments', () => {
  beforeEach(() => mockComplete.mockReset());

  it('applies PII removal to each segment text', async () => {
    const segments = [
      { speaker: 'Taler 1', start: 0, end: 2, text: 'Lars Jensen er til stede.' },
      { speaker: 'Taler 2', start: 3, end: 5, text: 'Goddag Lars.' },
    ];

    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          cleanedText: '[Taler 1]: [NAVN] er til stede.\n[Taler 2]: Goddag [NAVN].',
          replacements: [{ original: 'Lars Jensen', replacement: '[NAVN]', type: 'NAVN' }],
        }),
      ),
    );

    const { cleanedSegments, replacements } = await removePiiFromSegments(segments);

    expect(cleanedSegments[0].text).toBe('[NAVN] er til stede.');
    expect(cleanedSegments[1].text).toBe('Goddag [NAVN].');
    expect(replacements).toHaveLength(1);
  });

  it('preserves speaker, start, end from original segments', async () => {
    const segments = [{ speaker: 'Taler 1', start: 1.5, end: 3.2, text: 'Hej.' }];

    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({ cleanedText: '[Taler 1]: Hej.', replacements: [] }),
      ),
    );

    const { cleanedSegments } = await removePiiFromSegments(segments);

    expect(cleanedSegments[0].speaker).toBe('Taler 1');
    expect(cleanedSegments[0].start).toBe(1.5);
    expect(cleanedSegments[0].end).toBe(3.2);
  });

  it('falls back to original segment when cleaned line is missing', async () => {
    const segments = [
      { speaker: 'Taler 1', start: 0, end: 1, text: 'Original text.' },
      { speaker: 'Taler 2', start: 2, end: 3, text: 'Second line.' },
    ];

    // Return only one line in cleaned text — second segment has no matching line
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({ cleanedText: '[Taler 1]: Clean line.', replacements: [] }),
      ),
    );

    const { cleanedSegments } = await removePiiFromSegments(segments);

    expect(cleanedSegments[0].text).toBe('Clean line.');
    expect(cleanedSegments[1].text).toBe('Second line.');
  });

  it('sends segments formatted as [Speaker]: text to OpenAI', async () => {
    const segments = [
      { speaker: 'Taler 1', start: 0, end: 1, text: 'Hello.' },
      { speaker: 'Taler 2', start: 2, end: 3, text: 'World.' },
    ];

    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({ cleanedText: '[Taler 1]: Hello.\n[Taler 2]: World.', replacements: [] }),
      ),
    );

    await removePiiFromSegments(segments);

    const call = mockComplete.mock.calls[0][0];
    const userMessage = call.messages[1].content as string;
    expect(userMessage).toContain('[Taler 1]: Hello.');
    expect(userMessage).toContain('[Taler 2]: World.');
  });

  it('returns replacements from the PII removal step', async () => {
    const segments = [{ speaker: 'Taler 1', start: 0, end: 1, text: 'Kontakt Hans Nielsen.' }];

    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          cleanedText: '[Taler 1]: Kontakt [NAVN].',
          replacements: [{ original: 'Hans Nielsen', replacement: '[NAVN]', type: 'NAVN' }],
        }),
      ),
    );

    const { replacements } = await removePiiFromSegments(segments);
    expect(replacements).toHaveLength(1);
    expect(replacements[0].original).toBe('Hans Nielsen');
  });
});

// ─── detectPiiInSegments ──────────────────────────────────────────────────────

describe('detectPiiInSegments', () => {
  beforeEach(() => mockComplete.mockReset());

  it('returns replacements with segmentIndex when original is found in a segment', async () => {
    const segments = [
      { speaker: 'Taler 1', start: 0, end: 2, text: 'Lars Jensen er med.' },
      { speaker: 'Taler 2', start: 3, end: 5, text: 'Tak for det.' },
    ];

    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          cleanedText: '[Taler 1]: [NAVN] er med.\n[Taler 2]: Tak for det.',
          replacements: [{ original: 'Lars Jensen', replacement: '[NAVN]', type: 'NAVN' }],
        }),
      ),
    );

    const { replacements } = await detectPiiInSegments(segments);

    expect(replacements).toHaveLength(1);
    expect(replacements[0].segmentIndex).toBe(0);
  });

  it('sets segmentIndex to undefined when original is not found in any segment', async () => {
    const segments = [
      { speaker: 'Taler 1', start: 0, end: 2, text: 'Hej verden.' },
    ];

    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          cleanedText: '[Taler 1]: Hej verden.',
          replacements: [{ original: 'NonExistent', replacement: '[NAVN]', type: 'NAVN' }],
        }),
      ),
    );

    const { replacements } = await detectPiiInSegments(segments);
    expect(replacements[0].segmentIndex).toBeUndefined();
  });

  it('returns empty array when no PII is detected', async () => {
    const segments = [
      { speaker: 'Taler 1', start: 0, end: 2, text: 'Mødet starter nu.' },
    ];

    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({ cleanedText: '[Taler 1]: Mødet starter nu.', replacements: [] }),
      ),
    );

    const { replacements } = await detectPiiInSegments(segments);
    expect(replacements).toHaveLength(0);
  });

  it('returns empty array for empty segments input', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(JSON.stringify({ cleanedText: '', replacements: [] })),
    );

    const { replacements } = await detectPiiInSegments([]);
    expect(replacements).toHaveLength(0);
  });

  it('finds the correct segment index for each replacement', async () => {
    const segments = [
      { speaker: 'Taler 1', start: 0, end: 2, text: 'Jeg hedder Anna.' },
      { speaker: 'Taler 2', start: 3, end: 5, text: 'Og jeg er Bent.' },
    ];

    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          cleanedText: '[Taler 1]: Jeg hedder [NAVN].\n[Taler 2]: Og jeg er [NAVN].',
          replacements: [
            { original: 'Anna', replacement: '[NAVN]', type: 'NAVN' },
            { original: 'Bent', replacement: '[NAVN]', type: 'NAVN' },
          ],
        }),
      ),
    );

    const { replacements } = await detectPiiInSegments(segments);

    expect(replacements[0].segmentIndex).toBe(0);
    expect(replacements[1].segmentIndex).toBe(1);
  });
});

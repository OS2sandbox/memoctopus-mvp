import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: mockCreate };
  },
}));

import { removePii, removePiiFromSegments } from './pii';

// ─── removePii ────────────────────────────────────────────────────────────────

describe('removePii', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns cleanedText and replacements from a valid response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            cleanedText: 'Møde med [NAVN] om projektet.',
            replacements: [{ original: 'Lars Jensen', replacement: '[NAVN]', type: 'NAVN' }],
          }),
        },
      ],
    });

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
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: '```json\n{"cleanedText":"clean","replacements":[]}\n```',
        },
      ],
    });

    const result = await removePii('clean');
    expect(result.cleanedText).toBe('clean');
    expect(result.replacements).toHaveLength(0);
  });

  it('falls back to original text when JSON is invalid', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not valid json at all' }],
    });

    const result = await removePii('original text');
    expect(result.cleanedText).toBe('original text');
    expect(result.replacements).toHaveLength(0);
  });

  it('throws when response content type is not text', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'x', name: 'tool', input: {} }],
    });

    await expect(removePii('text')).rejects.toThrow('Unexpected response type from Claude');
  });

  it('handles multiple replacement types', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            cleanedText: '[NAVN] bor på [ADRESSE], tlf. [TELEFON]',
            replacements: [
              { original: 'Hans', replacement: '[NAVN]', type: 'NAVN' },
              { original: 'Nørrebrogade 1', replacement: '[ADRESSE]', type: 'ADRESSE' },
              { original: '12345678', replacement: '[TELEFON]', type: 'TELEFON' },
            ],
          }),
        },
      ],
    });

    const result = await removePii('Hans bor på Nørrebrogade 1, tlf. 12345678');
    expect(result.replacements).toHaveLength(3);
    expect(result.replacements.map((r) => r.type)).toEqual(['NAVN', 'ADRESSE', 'TELEFON']);
  });

  it('handles empty replacements array', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ cleanedText: 'No PII here.', replacements: [] }),
        },
      ],
    });

    const result = await removePii('No PII here.');
    expect(result.replacements).toHaveLength(0);
    expect(result.cleanedText).toBe('No PII here.');
  });
});

// ─── removePiiFromSegments ────────────────────────────────────────────────────

describe('removePiiFromSegments', () => {
  beforeEach(() => mockCreate.mockReset());

  it('applies PII removal to each segment text', async () => {
    const segments = [
      { speaker: 'Taler 1', start: 0, end: 2, text: 'Lars Jensen er til stede.' },
      { speaker: 'Taler 2', start: 3, end: 5, text: 'Goddag Lars.' },
    ];

    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            cleanedText:
              '[Taler 1]: [NAVN] er til stede.\n[Taler 2]: Goddag [NAVN].',
            replacements: [{ original: 'Lars Jensen', replacement: '[NAVN]', type: 'NAVN' }],
          }),
        },
      ],
    });

    const { cleanedSegments, replacements } = await removePiiFromSegments(segments);

    expect(cleanedSegments[0].text).toBe('[NAVN] er til stede.');
    expect(cleanedSegments[1].text).toBe('Goddag [NAVN].');
    expect(replacements).toHaveLength(1);
  });

  it('preserves speaker, start, end from original segments', async () => {
    const segments = [{ speaker: 'Taler 1', start: 1.5, end: 3.2, text: 'Hej.' }];

    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            cleanedText: '[Taler 1]: Hej.',
            replacements: [],
          }),
        },
      ],
    });

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
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            cleanedText: '[Taler 1]: Clean line.',
            replacements: [],
          }),
        },
      ],
    });

    const { cleanedSegments } = await removePiiFromSegments(segments);

    expect(cleanedSegments[0].text).toBe('Clean line.');
    // Second segment falls back to original
    expect(cleanedSegments[1].text).toBe('Second line.');
  });

  it('sends segments formatted as [Speaker]: text to the API', async () => {
    const segments = [
      { speaker: 'Taler 1', start: 0, end: 1, text: 'Hello.' },
      { speaker: 'Taler 2', start: 2, end: 3, text: 'World.' },
    ];

    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ cleanedText: '[Taler 1]: Hello.\n[Taler 2]: World.', replacements: [] }),
        },
      ],
    });

    await removePiiFromSegments(segments);

    const userMessage = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(userMessage).toContain('[Taler 1]: Hello.');
    expect(userMessage).toContain('[Taler 2]: World.');
  });
});

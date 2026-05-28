import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockComplete = vi.hoisted(() => vi.fn());

vi.mock('@mistralai/mistralai', () => ({
  Mistral: class {
    chat = { complete: mockComplete };
  },
}));

import { analyzeTopics } from './topics';

function mistralResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

// ─── analyzeTopics ────────────────────────────────────────────────────────────

describe('analyzeTopics', () => {
  beforeEach(() => mockComplete.mockReset());

  it('returns topics with follow-up questions from valid response', async () => {
    mockComplete.mockResolvedValueOnce(
      mistralResponse(
        JSON.stringify({
          topics: [
            {
              topic: 'Budget 2024',
              followUps: ['Hvornår er deadline?', 'Hvem er ansvarlig?'],
            },
            {
              topic: 'Personalemøde dato',
              followUps: ['Hvad er næste trin?'],
            },
          ],
        }),
      ),
    );

    const result = await analyzeTopics('Transskription af møde om budget og personale.');

    expect(result).toHaveLength(2);
    expect(result[0].topic).toBe('Budget 2024');
    expect(result[0].followUps).toHaveLength(2);
    expect(result[0].followUps[0]).toBe('Hvornår er deadline?');
    expect(result[1].topic).toBe('Personalemøde dato');
  });

  it('strips markdown code fences before parsing', async () => {
    mockComplete.mockResolvedValueOnce(
      mistralResponse(
        '```json\n{"topics":[{"topic":"T","followUps":["Q1"]}]}\n```',
      ),
    );

    const result = await analyzeTopics('test');
    expect(result[0].topic).toBe('T');
  });

  it('returns empty array when JSON is invalid', async () => {
    mockComplete.mockResolvedValueOnce(mistralResponse('not valid json'));

    const result = await analyzeTopics('text');
    expect(result).toEqual([]);
  });

  it('returns empty array when choices are empty', async () => {
    mockComplete.mockResolvedValueOnce({ choices: [] });

    const result = await analyzeTopics('text');
    expect(result).toEqual([]);
  });

  it('returns empty array when topics key is missing', async () => {
    mockComplete.mockResolvedValueOnce(mistralResponse(JSON.stringify({ other: 'data' })));

    const result = await analyzeTopics('text');
    expect(result).toEqual([]);
  });

  it('truncates transcript to last 3000 chars in the prompt', async () => {
    const longTranscript = 'A'.repeat(5000);

    mockComplete.mockResolvedValueOnce(mistralResponse(JSON.stringify({ topics: [] })));

    await analyzeTopics(longTranscript);

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    // transcript.slice(-3000) so the 5000-char input is trimmed; the user content should be well under 4000 chars
    const aCount = (userContent.match(/A/g) ?? []).length;
    expect(aCount).toBeLessThan(3005); // ≤ 3000 from transcript + a few from prompt template
  });

  it('uses the last 3000 chars (not the first) for long transcripts', async () => {
    // Build a string > 3000 chars: 400 repetitions of 'X' (3600 chars) + 'END_MARKER'
    const prefix = 'X'.repeat(3600);
    const suffix = 'END_MARKER';
    const longTranscript = prefix + suffix;

    mockComplete.mockResolvedValueOnce(mistralResponse(JSON.stringify({ topics: [] })));

    await analyzeTopics(longTranscript);

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    // The last 3000 chars ends with END_MARKER so it must appear
    expect(userContent).toContain('END_MARKER');
    // The very beginning of the 3600 Xs should be cut off
    const xCount = (userContent.match(/X/g) ?? []).length;
    expect(xCount).toBeLessThan(3600);
  });

  it('uses mistral-small-latest model', async () => {
    mockComplete.mockResolvedValueOnce(mistralResponse(JSON.stringify({ topics: [] })));

    await analyzeTopics('transcript');

    const call = mockComplete.mock.calls[0][0];
    expect(call.model).toBe('mistral-small-latest');
  });

  it('includes the transcript in the user message', async () => {
    mockComplete.mockResolvedValueOnce(mistralResponse(JSON.stringify({ topics: [] })));

    await analyzeTopics('budget diskussion');

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    expect(userContent).toContain('budget diskussion');
  });

  it('handles topics with empty followUps array', async () => {
    mockComplete.mockResolvedValueOnce(
      mistralResponse(
        JSON.stringify({
          topics: [{ topic: 'Emne uden opfølgning', followUps: [] }],
        }),
      ),
    );

    const result = await analyzeTopics('text');
    expect(result[0].followUps).toEqual([]);
  });

  it('handles empty transcript string', async () => {
    mockComplete.mockResolvedValueOnce(mistralResponse(JSON.stringify({ topics: [] })));

    const result = await analyzeTopics('');
    expect(result).toEqual([]);
  });
});

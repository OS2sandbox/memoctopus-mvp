import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mockCreate } };
  },
}));

import { analyzeClarifications } from './clarifications';

function openaiResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

// ─── analyzeClarifications ────────────────────────────────────────────────────

describe('analyzeClarifications', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns clarifying questions from a valid response', async () => {
    mockCreate.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          clarifications: [
            { question: 'Hvem er ansvarlig for budgettet?', context: 'Budget 2024' },
            { question: 'Hvornår er deadline?', context: 'Personalemøde' },
          ],
        }),
      ),
    );

    const result = await analyzeClarifications('Transskription af møde om budget og personale.');

    expect(result).toHaveLength(2);
    expect(result[0].question).toBe('Hvem er ansvarlig for budgettet?');
    expect(result[0].context).toBe('Budget 2024');
    expect(result[1].question).toBe('Hvornår er deadline?');
  });

  it('strips markdown code fences before parsing', async () => {
    mockCreate.mockResolvedValueOnce(
      openaiResponse('```json\n{"clarifications":[{"question":"Q?","context":"C"}]}\n```'),
    );

    const result = await analyzeClarifications('test');
    expect(result[0].question).toBe('Q?');
  });

  it('returns empty array when JSON is invalid', async () => {
    mockCreate.mockResolvedValueOnce(openaiResponse('not json'));
    expect(await analyzeClarifications('test')).toEqual([]);
  });

  it('returns empty array when the response has no content', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: {} }] });
    expect(await analyzeClarifications('test')).toEqual([]);
  });
});

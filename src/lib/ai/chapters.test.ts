import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockComplete = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mockComplete } };
  },
}));

import { groupIntoChapters } from './chapters';
import type { TranscriptSegment } from '@/types';

function openaiResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

const shortMeeting: TranscriptSegment[] = [
  { speaker: 'Taler 1', start: 0, end: 30, text: 'Vi starter mødet.' },
  { speaker: 'Taler 2', start: 35, end: 60, text: 'Første emne er budget.' },
  { speaker: 'Taler 1', start: 65, end: 90, text: 'Hvad er status?' },
];

const longMeeting: TranscriptSegment[] = Array.from({ length: 30 }, (_, i) => ({
  speaker: `Taler ${(i % 2) + 1}`,
  start: i * 60,
  end: (i + 1) * 60,
  text: `Segment ${i} om emnet.`,
}));

// ─── groupIntoChapters ────────────────────────────────────────────────────────

describe('groupIntoChapters', () => {
  beforeEach(() => mockComplete.mockReset());

  it('returns empty array for empty segments', async () => {
    const result = await groupIntoChapters([]);
    expect(result).toEqual([]);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('returns chapters with ids prefixed ch-', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          chapters: [{ startIndex: 0, title: 'Åbning', summary: 'Mødet åbnes.' }],
        }),
      ),
    );

    const result = await groupIntoChapters(shortMeeting);

    expect(result[0].id).toBe('ch-0');
  });

  it('maps chapter titles and summaries from response', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          chapters: [{ startIndex: 0, title: 'Budgetgennemgang', summary: 'Diskussion af budget.' }],
        }),
      ),
    );

    const result = await groupIntoChapters(shortMeeting);

    expect(result[0].title).toBe('Budgetgennemgang');
    expect(result[0].summary).toBe('Diskussion af budget.');
  });

  it('derives startTime from the first segment in each chapter', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          chapters: [
            { startIndex: 0, title: 'Del 1', summary: 's1' },
            { startIndex: 2, title: 'Del 2', summary: 's2' },
          ],
        }),
      ),
    );

    const result = await groupIntoChapters(shortMeeting);

    expect(result[0].startTime).toBe(0);   // shortMeeting[0].start
    expect(result[1].startTime).toBe(65);  // shortMeeting[2].start
  });

  it('derives endTime from the last segment in each chapter', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          chapters: [
            { startIndex: 0, title: 'Del 1', summary: 's1' },
            { startIndex: 2, title: 'Del 2', summary: 's2' },
          ],
        }),
      ),
    );

    const result = await groupIntoChapters(shortMeeting);

    expect(result[1].endTime).toBe(90);    // shortMeeting[2].end
  });

  it('clamps previous chapter endTime to next chapter startTime to prevent overlap', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          chapters: [
            { startIndex: 0, title: 'Del 1', summary: 's1' },
            { startIndex: 2, title: 'Del 2', summary: 's2' },
          ],
        }),
      ),
    );

    const result = await groupIntoChapters(shortMeeting);

    // chapter[0].endTime should not exceed chapter[1].startTime
    expect(result[0].endTime).toBeLessThanOrEqual(result[1].startTime);
  });

  it('computes contiguous segmentIndices from startIndex boundaries', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          chapters: [
            { startIndex: 0, title: 'Del 1', summary: 's' },
            { startIndex: 2, title: 'Del 2', summary: 's' },
          ],
        }),
      ),
    );

    const result = await groupIntoChapters(shortMeeting);

    expect(result[0].segmentIndices).toEqual([0, 1]);
    expect(result[1].segmentIndices).toEqual([2]);
  });

  it('falls back to a single chapter covering all segments when JSON is invalid', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('not valid json at all'));

    const result = await groupIntoChapters(shortMeeting);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ch-0');
    expect(result[0].title).toBe('Transskription');
    expect(result[0].segmentIndices).toEqual([0, 1, 2]);
  });

  it('strips markdown code fences before parsing', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        '```json\n{"chapters":[{"startIndex":0,"title":"T","summary":"S"}]}\n```',
      ),
    );

    const result = await groupIntoChapters(shortMeeting);
    expect(result[0].title).toBe('T');
  });

  it('uses configured LLM model', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(JSON.stringify({ chapters: [{ startIndex: 0, title: 'T', summary: 'S' }] })),
    );

    await groupIntoChapters(shortMeeting);

    const call = mockComplete.mock.calls[0][0];
    expect(call.model).toBe(process.env.LLM_MODEL ?? 'Qwen/Qwen3.6-27B');
  });

  it('includes segment indices in the prompt', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(JSON.stringify({ chapters: [{ startIndex: 0, title: 'T', summary: 'S' }] })),
    );

    await groupIntoChapters(shortMeeting);

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    expect(userContent).toContain('[0]');
    expect(userContent).toContain('[1]');
    expect(userContent).toContain('[2]');
  });

  it('uses chapter range "1" for meetings shorter than 5 minutes', async () => {
    const shortSegments: TranscriptSegment[] = [
      { speaker: 'Taler 1', start: 0, end: 120, text: 'Kort møde.' },
    ];

    mockComplete.mockResolvedValueOnce(
      openaiResponse(JSON.stringify({ chapters: [{ startIndex: 0, title: 'T', summary: 'S' }] })),
    );

    await groupIntoChapters(shortSegments);

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    expect(userContent).toContain('1 kapitel');
  });

  it('uses chapter range "3–6" for long meetings (≥ 30 min)', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          chapters: [
            { startIndex: 0, title: 'K1', summary: 'S' },
            { startIndex: 10, title: 'K2', summary: 'S' },
            { startIndex: 20, title: 'K3', summary: 'S' },
          ],
        }),
      ),
    );

    await groupIntoChapters(longMeeting);

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    expect(userContent).toContain('3–6');
  });

  it('fallback chapter startTime and endTime cover full meeting', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('bad json'));

    const result = await groupIntoChapters(shortMeeting);

    expect(result[0].startTime).toBe(shortMeeting[0].start);
    expect(result[0].endTime).toBe(shortMeeting[shortMeeting.length - 1].end);
  });
});

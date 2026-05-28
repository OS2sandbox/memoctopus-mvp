import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockComplete = vi.hoisted(() => vi.fn());

vi.mock('@mistralai/mistralai', () => ({
  Mistral: class {
    chat = { complete: mockComplete };
  },
}));

import { groupIntoChapters } from './chapters';
import type { TranscriptSegment } from '@/types';

function mistralResponse(content: string) {
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
      mistralResponse(
        JSON.stringify({
          chapters: [
            { title: 'Åbning', summary: 'Mødet åbnes.', segmentIndices: [0, 1, 2] },
          ],
        }),
      ),
    );

    const result = await groupIntoChapters(shortMeeting);

    expect(result[0].id).toBe('ch-0');
  });

  it('maps chapter titles and summaries from response', async () => {
    mockComplete.mockResolvedValueOnce(
      mistralResponse(
        JSON.stringify({
          chapters: [
            { title: 'Budgetgennemgang', summary: 'Diskussion af budget.', segmentIndices: [0, 1, 2] },
          ],
        }),
      ),
    );

    const result = await groupIntoChapters(shortMeeting);

    expect(result[0].title).toBe('Budgetgennemgang');
    expect(result[0].summary).toBe('Diskussion af budget.');
  });

  it('derives startTime from the first segment in each chapter', async () => {
    mockComplete.mockResolvedValueOnce(
      mistralResponse(
        JSON.stringify({
          chapters: [
            { title: 'Del 1', summary: 's1', segmentIndices: [0, 1] },
            { title: 'Del 2', summary: 's2', segmentIndices: [2] },
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
      mistralResponse(
        JSON.stringify({
          chapters: [
            { title: 'Del 1', summary: 's1', segmentIndices: [0, 1] },
            { title: 'Del 2', summary: 's2', segmentIndices: [2] },
          ],
        }),
      ),
    );

    const result = await groupIntoChapters(shortMeeting);

    expect(result[1].endTime).toBe(90);    // shortMeeting[2].end
  });

  it('clamps previous chapter endTime to next chapter startTime to prevent overlap', async () => {
    mockComplete.mockResolvedValueOnce(
      mistralResponse(
        JSON.stringify({
          chapters: [
            { title: 'Del 1', summary: 's1', segmentIndices: [0, 1] },
            { title: 'Del 2', summary: 's2', segmentIndices: [2] },
          ],
        }),
      ),
    );

    const result = await groupIntoChapters(shortMeeting);

    // chapter[0].endTime should not exceed chapter[1].startTime
    expect(result[0].endTime).toBeLessThanOrEqual(result[1].startTime);
  });

  it('stores segmentIndices from the response', async () => {
    mockComplete.mockResolvedValueOnce(
      mistralResponse(
        JSON.stringify({
          chapters: [
            { title: 'Del 1', summary: 's', segmentIndices: [0, 1] },
            { title: 'Del 2', summary: 's', segmentIndices: [2] },
          ],
        }),
      ),
    );

    const result = await groupIntoChapters(shortMeeting);

    expect(result[0].segmentIndices).toEqual([0, 1]);
    expect(result[1].segmentIndices).toEqual([2]);
  });

  it('falls back to a single chapter covering all segments when JSON is invalid', async () => {
    mockComplete.mockResolvedValueOnce(mistralResponse('not valid json at all'));

    const result = await groupIntoChapters(shortMeeting);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ch-0');
    expect(result[0].title).toBe('Transskription');
    expect(result[0].segmentIndices).toEqual([0, 1, 2]);
  });

  it('strips markdown code fences before parsing', async () => {
    mockComplete.mockResolvedValueOnce(
      mistralResponse(
        '```json\n{"chapters":[{"title":"T","summary":"S","segmentIndices":[0,1,2]}]}\n```',
      ),
    );

    const result = await groupIntoChapters(shortMeeting);
    expect(result[0].title).toBe('T');
  });

  it('uses mistral-large-latest model', async () => {
    mockComplete.mockResolvedValueOnce(
      mistralResponse(JSON.stringify({ chapters: [{ title: 'T', summary: 'S', segmentIndices: [0, 1, 2] }] })),
    );

    await groupIntoChapters(shortMeeting);

    const call = mockComplete.mock.calls[0][0];
    expect(call.model).toBe('mistral-large-latest');
  });

  it('includes segment indices in the prompt', async () => {
    mockComplete.mockResolvedValueOnce(
      mistralResponse(JSON.stringify({ chapters: [{ title: 'T', summary: 'S', segmentIndices: [0, 1, 2] }] })),
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
      mistralResponse(JSON.stringify({ chapters: [{ title: 'T', summary: 'S', segmentIndices: [0] }] })),
    );

    await groupIntoChapters(shortSegments);

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    expect(userContent).toContain('1 kapitel');
  });

  it('uses chapter range "3–6" for long meetings (≥ 30 min)', async () => {
    mockComplete.mockResolvedValueOnce(
      mistralResponse(
        JSON.stringify({
          chapters: longMeeting.map((_, i) => ({ title: `K${i}`, summary: 'S', segmentIndices: [i] })).slice(0, 4),
        }),
      ),
    );

    await groupIntoChapters(longMeeting);

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    expect(userContent).toContain('3–6');
  });

  it('fallback chapter startTime and endTime cover full meeting', async () => {
    mockComplete.mockResolvedValueOnce(mistralResponse('bad json'));

    const result = await groupIntoChapters(shortMeeting);

    expect(result[0].startTime).toBe(shortMeeting[0].start);
    expect(result[0].endTime).toBe(shortMeeting[shortMeeting.length - 1].end);
  });
});

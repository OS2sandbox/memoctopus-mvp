import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSuggestTemplate = vi.hoisted(() => vi.fn());
const mockGenerateMinutes = vi.hoisted(() => vi.fn());
const mockGenerateMinutesFreeform = vi.hoisted(() => vi.fn());
const mockGetTemplates = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/minutes', () => ({
  suggestTemplate: mockSuggestTemplate,
  generateMinutes: mockGenerateMinutes,
  generateMinutesFreeform: mockGenerateMinutesFreeform,
}));

vi.mock('@/lib/storage/templates', () => ({
  getTemplates: mockGetTemplates,
}));

import { POST } from './route';
import { makeJsonReq } from '@/test/helpers';

const BASE_URL = 'http://localhost/api/minutes';

const sampleSegments = [
  { speaker: 'Taler 1', start: 0, end: 5, text: 'Vi besluttede at gå videre.' },
];

const sampleContent = { sections: [{ key: 'beslutninger', label: 'Beslutninger', content: 'Gå videre.' }] };

const templates = [
  { id: 'tpl-standard', name: 'Standard', description: 'Standard referat', isDefault: true, structure: { sections: [{ key: 'beslutninger', label: 'Beslutninger', required: true }] } },
  { id: 'tpl-kort', name: 'Kort', description: 'Kort referat', isDefault: false, structure: { sections: [] } },
];

// The route generates minutes from client-supplied segments via the AI helpers.
// It does NOT touch auth or the database — persistence is client-side (IndexedDB).
describe('POST /api/minutes', () => {
  beforeEach(() => {
    mockSuggestTemplate.mockReset();
    mockGenerateMinutes.mockReset();
    mockGenerateMinutesFreeform.mockReset();
    mockGetTemplates.mockReset();
    mockGetTemplates.mockReturnValue(templates);
  });

  it('returns 400 when segments is missing', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('No segments provided');
  });

  it('returns 400 when segments is empty', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: [] }));
    expect(res.status).toBe(400);
  });

  it('suggests a template and returns generated content + templateId', async () => {
    mockSuggestTemplate.mockResolvedValueOnce({ templateId: 'tpl-standard' });
    mockGenerateMinutes.mockResolvedValueOnce(sampleContent);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.templateId).toBe('tpl-standard');
    expect(body.content).toEqual(sampleContent);
    expect(mockGenerateMinutes).toHaveBeenCalledOnce();
    expect(mockGenerateMinutesFreeform).not.toHaveBeenCalled();
  });

  it('falls back to the default template when the suggestion is unknown', async () => {
    mockSuggestTemplate.mockResolvedValueOnce({ templateId: 'does-not-exist' });
    mockGenerateMinutes.mockResolvedValueOnce(sampleContent);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));

    expect(res.status).toBe(200);
    expect((await res.json()).templateId).toBe('tpl-standard'); // the isDefault template
  });

  it('uses freeform generation (templateId null) when a customPrompt is given', async () => {
    mockGenerateMinutesFreeform.mockResolvedValueOnce(sampleContent);

    const res = await POST(
      makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments, customPrompt: 'Fokusér på beslutninger' }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.templateId).toBeNull();
    expect(body.content).toEqual(sampleContent);
    expect(mockGenerateMinutesFreeform).toHaveBeenCalledOnce();
    expect(mockSuggestTemplate).not.toHaveBeenCalled();
    expect(mockGenerateMinutes).not.toHaveBeenCalled();
  });

  it('forwards participants and chapters to the generator', async () => {
    mockSuggestTemplate.mockResolvedValueOnce({ templateId: 'tpl-standard' });
    mockGenerateMinutes.mockResolvedValueOnce(sampleContent);
    const participants = ['Alice', 'Bob'];
    const chapters = [{ id: 'ch-0', title: 'Intro', summary: 'S', startTime: 0, endTime: 5, segmentIndices: [0] }];

    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments, participants, chapters }));

    // generateMinutes(segments, sections, undefined, participants, chapters)
    const args = mockGenerateMinutes.mock.calls[0];
    expect(args[3]).toEqual(participants);
    expect(args[4]).toEqual(chapters);
  });

  it('returns 500 when no templates are available', async () => {
    mockGetTemplates.mockReturnValue([]);
    mockSuggestTemplate.mockResolvedValueOnce({ templateId: null });

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('No templates available');
  });
});

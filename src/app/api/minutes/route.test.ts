import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSuggestTemplate = vi.hoisted(() => vi.fn());
const mockGenerateMinutes = vi.hoisted(() => vi.fn());
const mockGenerateMinutesFreeform = vi.hoisted(() => vi.fn());
const mockDeleteAudioFile = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchemaOne: vi.fn(),
  queryUserSchema: vi.fn(),
}));

vi.mock('@/lib/ai/minutes', () => ({
  suggestTemplate: mockSuggestTemplate,
  generateMinutes: mockGenerateMinutes,
  generateMinutesFreeform: mockGenerateMinutesFreeform,
}));

vi.mock('@/lib/audio/storage', () => ({
  deleteAudioFile: mockDeleteAudioFile,
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne, queryUserSchema } from '@/lib/db/user-schema';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryOne = vi.mocked(queryUserSchemaOne);
const mockQueryMany = vi.mocked(queryUserSchema);

const BASE_URL = 'http://localhost/api/minutes';

const sampleSegments = [
  { speaker: 'Taler 1', start: 0, end: 5, text: 'Vi åbner mødet.' },
  { speaker: 'Taler 2', start: 6, end: 10, text: 'Første emne.' },
];

const sampleTemplates = [
  { id: 'tmpl-1', name: 'Bestyrelsesmøde', description: 'Standard', structure: { sections: [{ key: 'beslutninger', label: 'Beslutninger', required: true }] }, is_default: true },
];

const sampleMinutesContent = {
  sections: [{ key: 'beslutninger', label: 'Beslutninger', content: 'Ingen.' }],
};

// ─── POST /api/minutes ────────────────────────────────────────────────────────

describe('POST /api/minutes', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
    mockQueryMany.mockReset();
    mockSuggestTemplate.mockReset();
    mockGenerateMinutes.mockReset();
    mockGenerateMinutesFreeform.mockReset();
    mockDeleteAudioFile.mockResolvedValue(undefined);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { meetingId: 'meet-1', transcriptId: 'tid-1', segments: sampleSegments }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when meetingId is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { transcriptId: 'tid-1', segments: sampleSegments }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/missing/i);
  });

  it('returns 400 when transcriptId is missing', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { meetingId: 'meet-1', segments: sampleSegments }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when meeting not found', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null as never); // meeting lookup

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { meetingId: 'meet-1', transcriptId: 'tid-1', segments: sampleSegments }));
    expect(res.status).toBe(404);
  });

  it('generates minutes with template selection and returns minutesId', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never); // meeting lookup
    mockQueryMany.mockResolvedValueOnce(sampleTemplates as never); // templates
    mockSuggestTemplate.mockResolvedValueOnce({ templateId: 'tmpl-1', templateName: 'Bestyrelsesmøde', explanation: 'x' });
    mockGenerateMinutes.mockResolvedValueOnce(sampleMinutesContent);
    mockQueryOne.mockResolvedValueOnce({} as never); // DELETE existing minutes
    mockQueryOne.mockResolvedValueOnce({ id: 'min-new' } as never); // INSERT minutes
    mockQueryOne.mockResolvedValueOnce({} as never); // UPDATE meeting status
    mockQueryMany.mockResolvedValueOnce([{ filename: 'audio.webm' }] as never); // audio files
    mockQueryMany.mockResolvedValueOnce([] as never); // UPDATE audio deleted_at

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { meetingId: 'meet-1', transcriptId: 'tid-1', segments: sampleSegments }));

    expect(res.status).toBe(200);
    expect((await res.json()).minutesId).toBe('min-new');
  });

  it('calls generateMinutesFreeform when customPrompt is provided', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockGenerateMinutesFreeform.mockResolvedValueOnce(sampleMinutesContent);
    mockQueryOne.mockResolvedValueOnce({} as never); // DELETE
    mockQueryOne.mockResolvedValueOnce({ id: 'min-free' } as never); // INSERT
    mockQueryOne.mockResolvedValueOnce({} as never); // UPDATE status
    mockQueryMany.mockResolvedValueOnce([] as never); // audio files
    mockQueryMany.mockResolvedValueOnce([] as never); // UPDATE audio

    const res = await POST(
      makeJsonReq(BASE_URL, 'POST', {
        meetingId: 'meet-1',
        transcriptId: 'tid-1',
        segments: sampleSegments,
        customPrompt: 'Fokus på beslutninger',
      }),
    );

    expect(res.status).toBe(200);
    expect(mockGenerateMinutesFreeform).toHaveBeenCalledWith(sampleSegments, 'Fokus på beslutninger', undefined);
    expect(mockGenerateMinutes).not.toHaveBeenCalled();
    expect(mockSuggestTemplate).not.toHaveBeenCalled();
  });

  it('does not call generateMinutesFreeform when no customPrompt is provided', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockQueryMany.mockResolvedValueOnce(sampleTemplates as never);
    mockSuggestTemplate.mockResolvedValueOnce({ templateId: 'tmpl-1', templateName: 'X', explanation: 'x' });
    mockGenerateMinutes.mockResolvedValueOnce(sampleMinutesContent);
    mockQueryOne.mockResolvedValueOnce({} as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'min-1' } as never);
    mockQueryOne.mockResolvedValueOnce({} as never);
    mockQueryMany.mockResolvedValueOnce([] as never);
    mockQueryMany.mockResolvedValueOnce([] as never);

    await POST(makeJsonReq(BASE_URL, 'POST', { meetingId: 'meet-1', transcriptId: 'tid-1', segments: sampleSegments }));

    expect(mockGenerateMinutesFreeform).not.toHaveBeenCalled();
  });

  it('updates meeting status to minutes after generation', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockQueryMany.mockResolvedValueOnce(sampleTemplates as never);
    mockSuggestTemplate.mockResolvedValueOnce({ templateId: 'tmpl-1', templateName: 'X', explanation: 'x' });
    mockGenerateMinutes.mockResolvedValueOnce(sampleMinutesContent);
    mockQueryOne.mockResolvedValueOnce({} as never); // DELETE
    mockQueryOne.mockResolvedValueOnce({ id: 'min-1' } as never); // INSERT
    mockQueryOne.mockResolvedValueOnce({} as never); // UPDATE status
    mockQueryMany.mockResolvedValueOnce([] as never);
    mockQueryMany.mockResolvedValueOnce([] as never);

    await POST(makeJsonReq(BASE_URL, 'POST', { meetingId: 'meet-1', transcriptId: 'tid-1', segments: sampleSegments }));

    const statusUpdate = mockQueryOne.mock.calls.find(
      ([, sql]) => typeof sql === 'string' && sql.includes("'minutes'"),
    );
    expect(statusUpdate).toBeDefined();
  });

  it('uses the default template when suggestion does not match any template', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockQueryMany.mockResolvedValueOnce(sampleTemplates as never);
    mockSuggestTemplate.mockResolvedValueOnce({ templateId: 'non-existent', templateName: 'X', explanation: 'x' });
    mockGenerateMinutes.mockResolvedValueOnce(sampleMinutesContent);
    mockQueryOne.mockResolvedValueOnce({} as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'min-1' } as never);
    mockQueryOne.mockResolvedValueOnce({} as never);
    mockQueryMany.mockResolvedValueOnce([] as never);
    mockQueryMany.mockResolvedValueOnce([] as never);

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { meetingId: 'meet-1', transcriptId: 'tid-1', segments: sampleSegments }));

    expect(res.status).toBe(200);
    // Should have used sampleTemplates[0] (is_default) and called generateMinutes
    expect(mockGenerateMinutes).toHaveBeenCalled();
  });

  it('returns 500 when no templates are available', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce({ id: 'meet-1' } as never);
    mockQueryMany.mockResolvedValueOnce([] as never); // no templates
    mockSuggestTemplate.mockResolvedValueOnce({ templateId: null, templateName: 'X', explanation: 'x' });

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { meetingId: 'meet-1', transcriptId: 'tid-1', segments: sampleSegments }));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/no templates/i);
  });
});

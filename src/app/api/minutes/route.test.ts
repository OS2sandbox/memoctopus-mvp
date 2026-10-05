import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

const mockGenerateReferatBody = vi.hoisted(() => vi.fn());
const mockGetSkabelon = vi.hoisted(() => vi.fn());
const mockGetDefaultSkabelon = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/minutes', () => ({
  generateReferatBody: mockGenerateReferatBody,
}));

vi.mock('@/lib/skabeloner/server', () => ({
  getSkabelon: mockGetSkabelon,
  getDefaultSkabelon: mockGetDefaultSkabelon,
}));

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: mockRecord,
}));

import { POST } from './route';
import { expectValidMetadataOnly, leakyError } from '@/app/api/meetings/ai-audit.test-utils';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);

const BASE_URL = 'http://localhost/api/minutes';
const sampleSegments = [{ speaker: 'Taler 1', start: 0, end: 5, text: 'Vi besluttede at gå videre.' }];
const sampleContent = { body: '## Beslutninger\n\nGå videre.' };

const defaultSkabelon = {
  id: 'sk-default',
  name: 'Bestyrelsesmøde',
  description: '',
  prompt: 'Lav et referat.',
  includeDeltagere: true,
  includeBeslutningspunkter: true,
  includeDagsorden: true,
  includeDato: false,
  isDefault: true,
  createdAt: '', updatedAt: '',
};

describe('POST /api/minutes', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockGenerateReferatBody.mockReset();
    mockGetSkabelon.mockReset();
    mockGetDefaultSkabelon.mockReset();
    mockGetDefaultSkabelon.mockResolvedValue(defaultSkabelon);
    mockGenerateReferatBody.mockResolvedValue(sampleContent);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when segments is missing', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('No segments provided');
  });

  it('generates the body using the default skabelon and returns its id', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toEqual(sampleContent);
    expect(body.skabelonId).toBe('sk-default');
    expect(mockGetDefaultSkabelon).toHaveBeenCalledOnce();
  });

  it('loads the chosen skabelon when skabelonId is provided', async () => {
    mockGetSkabelon.mockResolvedValueOnce({ ...defaultSkabelon, id: 'sk-1' });

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments, skabelonId: 'sk-1' }));

    expect(res.status).toBe(200);
    expect((await res.json()).skabelonId).toBe('sk-1');
    expect(mockGetSkabelon).toHaveBeenCalledWith('user-123', 'sk-1');
    expect(mockGetDefaultSkabelon).not.toHaveBeenCalled();
  });

  it('uses no skabelon when skabelonId is an explicit empty string ("Ingen skabelon")', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments, skabelonId: '' }));

    expect(res.status).toBe(200);
    expect((await res.json()).skabelonId).toBe(null);
    expect(mockGetDefaultSkabelon).not.toHaveBeenCalled();
    expect(mockGetSkabelon).not.toHaveBeenCalled();
    // No skabelon → empty base prompt and NO tags silently inherited from the
    // default skabelon, even though category flags were omitted from the request.
    const spec = mockGenerateReferatBody.mock.calls[0][1];
    expect(spec.prompt).toBe('');
    expect(spec.includeDeltagere).toBe(false);
    expect(spec.includeBeslutningspunkter).toBe(false);
    expect(spec.includeDagsorden).toBe(false);
    expect(spec.includeDato).toBe(false);
  });

  it('lets explicit category toggles override the skabelon defaults', async () => {
    await POST(makeJsonReq(BASE_URL, 'POST', {
      segments: sampleSegments,
      includeDeltagere: false,
      includeDagsorden: false,
    }));

    // generateReferatBody(segments, spec, participants, chapters, customPrompt)
    const spec = mockGenerateReferatBody.mock.calls[0][1];
    expect(spec.includeDeltagere).toBe(false);
    expect(spec.includeDagsorden).toBe(false);
    expect(spec.includeBeslutningspunkter).toBe(true); // unchanged → from skabelon
  });

  it('forwards participants, chapters and customPrompt to the generator', async () => {
    const participants = ['Alice', 'Bob'];
    const chapters = [{ id: 'ch-0', title: 'Intro', summary: 'S', startTime: 0, endTime: 5, segmentIndices: [0] }];

    await POST(makeJsonReq(BASE_URL, 'POST', {
      segments: sampleSegments, participants, chapters, customPrompt: 'kort',
    }));

    const args = mockGenerateReferatBody.mock.calls[0];
    expect(args[2]).toEqual(participants);
    expect(args[3]).toEqual(chapters);
    expect(args[4]).toBe('kort');
  });

  it('returns JSON 500 with parseable body when generateReferatBody throws', async () => {
    mockGenerateReferatBody.mockRejectedValueOnce(new Error('OpenAI timeout'));

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty('error');
    // Must be JSON (not HTML) so the client can parse it without crashing.
    expect(typeof body.error).toBe('string');
  });
});

describe('audit: minutes.generate', () => {
  const MEETING = '11111111-2222-4333-8444-555555555555';
  const TEMPLATE = '22222222-3333-4444-8555-666666666666';
  const events = () => mockRecord.mock.calls.map((c) => c[1]);

  beforeEach(() => {
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({ status: 'stored' });
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
    mockGenerateReferatBody.mockReset();
    mockGenerateReferatBody.mockResolvedValue(sampleContent);
    mockGetSkabelon.mockReset();
    mockGetDefaultSkabelon.mockReset();
    mockGetDefaultSkabelon.mockResolvedValue({ ...defaultSkabelon, id: TEMPLATE });
  });

  const CONTENT_STRINGS = ['Vi besluttede', 'Bestyrelsesmøde', 'Lav et referat', 'Gå videre', 'Alice'];

  it('emits one event with the default template as secondary entity and no meeting entity when none is sent', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments, participants: ['Alice'] }));
    expect(res.status).toBe(200);

    expect(events()).toHaveLength(1);
    const e = events()[0];
    expect(e).toMatchObject({
      type: 'minutes.generate',
      actorUserId: 'user-123',
      secondaryEntityId: TEMPLATE,
      details: { templateSource: 'default', segmentCount: 1 },
    });
    expect(e.entityId).toBeUndefined();
    expect(e.outcome ?? 'success').toBe('success');
    expect(typeof e.details.durationMs).toBe('number');
    expect(e.details).not.toHaveProperty('outcomeCode');
    expectValidMetadataOnly(e, CONTENT_STRINGS);
  });

  it('marks an explicitly chosen template as personal and records a valid meeting id', async () => {
    mockGetSkabelon.mockResolvedValueOnce({ ...defaultSkabelon, id: TEMPLATE, isDefault: false });
    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments, skabelonId: TEMPLATE, meetingId: MEETING }));

    const e = events()[0];
    expect(e).toMatchObject({ entityId: MEETING, secondaryEntityId: TEMPLATE, details: { templateSource: 'personal' } });
    expectValidMetadataOnly(e, CONTENT_STRINGS);
  });

  it('reports "default" when a stale template id falls back to the default', async () => {
    mockGetSkabelon.mockResolvedValueOnce(null);
    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments, skabelonId: 'gone' }));
    expect(events()[0].details.templateSource).toBe('default');
  });

  it('reports "none" and no secondary entity for "Ingen skabelon"', async () => {
    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments, skabelonId: '' }));
    const e = events()[0];
    expect(e.details.templateSource).toBe('none');
    expect(e.secondaryEntityId).toBeUndefined();
    expectValidMetadataOnly(e);
  });

  it('never uses a non-UUID meeting id or template id as an entity (the event stays valid)', async () => {
    mockGetDefaultSkabelon.mockResolvedValueOnce(defaultSkabelon); // id 'sk-default'
    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments, meetingId: 'Referat om sag 42' }));

    const e = events()[0];
    expect(e.entityId).toBeUndefined();
    expect(e.secondaryEntityId).toBeUndefined();
    expectValidMetadataOnly(e, ['sag 42', 'sk-default']);
  });

  it('records outcome error with a code, never the error message, and still answers 500', async () => {
    mockGenerateReferatBody.mockRejectedValueOnce(
      leakyError('Vi besluttede at gå videre med Alice', { status: 429, code: 'rate_limit_exceeded' }),
    );
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments, participants: ['Alice'] }));

    expect(res.status).toBe(500);
    expect(events()).toHaveLength(1);
    const e = events()[0];
    expect(e.outcome).toBe('error');
    expect(e.details.outcomeCode).toBe('rate_limit_exceeded');
    expectValidMetadataOnly(e, CONTENT_STRINGS);
  });

  it('does not log the AI error message to the server log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGenerateReferatBody.mockRejectedValueOnce(leakyError('Vi besluttede at gå videre'));
    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Vi besluttede');
    spy.mockRestore();
  });

  it('still answers 200 with the minutes when the audit write rejects', async () => {
    mockRecord.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));
    expect(res.status).toBe(200);
    expect((await res.json()).content).toEqual(sampleContent);
    warn.mockRestore();
  });

  it('still answers 200 when the event is dropped as invalid', async () => {
    mockRecord.mockResolvedValueOnce({ status: 'dropped', code: 'invalid_details' });
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));
    expect(res.status).toBe(200);
  });

  it('emits nothing for unauthenticated or invalid requests', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));
    await POST(makeJsonReq(BASE_URL, 'POST', {}));
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

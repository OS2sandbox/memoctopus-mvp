import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchemaOne: vi.fn(),
}));

const { jsPDFInstance, MockJsPDF, MockParagraph, MockTextRun, MockDocument, mockPackerToBuffer } = vi.hoisted(() => {
  const jsPDFInstance = {
    setFont: vi.fn(),
    setFontSize: vi.fn(),
    setTextColor: vi.fn(),
    setDrawColor: vi.fn(),
    text: vi.fn(),
    line: vi.fn(),
    addPage: vi.fn(),
    splitTextToSize: vi.fn().mockReturnValue(['line1']),
    output: vi.fn().mockReturnValue(new ArrayBuffer(8)),
    internal: { pageSize: { getWidth: vi.fn().mockReturnValue(210) } },
  };
  return {
    jsPDFInstance,
    MockJsPDF: vi.fn(),
    MockParagraph: vi.fn(),
    MockTextRun: vi.fn(),
    MockDocument: vi.fn(),
    mockPackerToBuffer: vi.fn(),
  };
});

vi.mock('jspdf', () => ({ jsPDF: MockJsPDF }));
vi.mock('docx', () => ({
  Document: MockDocument,
  Packer: { toBuffer: mockPackerToBuffer },
  Paragraph: MockParagraph,
  TextRun: MockTextRun,
  HeadingLevel: { HEADING_1: 'HEADING_1', HEADING_2: 'HEADING_2' },
  AlignmentType: { LEFT: 'left' },
  BorderStyle: { SINGLE: 'single' },
}));

import { GET } from './route';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';

const mockGetSession = vi.mocked(auth.api.getSession);
const mockQueryOne = vi.mocked(queryUserSchemaOne);

const MEETING_ID = 'meet-export-1';
const BASE_URL = `http://localhost/api/export/${MEETING_ID}`;
const PARAMS = { params: Promise.resolve({ id: MEETING_ID }) };

const FAKE_MEETING = { id: MEETING_ID, title: 'Styregruppemøde' };
const FAKE_MINUTES_CONTENT = {
  sections: [
    { key: 'beslutninger', label: 'Beslutninger', content: 'Vi besluttede noget.' },
    { key: 'opgaver', label: 'Opgaver', content: '' },
  ],
};
const FAKE_MINUTES_ROW = { content: FAKE_MINUTES_CONTENT, version: 2 };

describe('GET /api/export/[id]', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockQueryOne.mockReset();
    MockJsPDF.mockReset();
    MockParagraph.mockReset();
    MockTextRun.mockReset();
    MockDocument.mockReset();
    mockPackerToBuffer.mockReset();

    MockJsPDF.mockImplementation(class { constructor() { return jsPDFInstance; } });
    MockParagraph.mockImplementation(class {});
    MockTextRun.mockImplementation(class {});
    MockDocument.mockImplementation(class {});
    mockPackerToBuffer.mockResolvedValue(Buffer.from('docx'));

    jsPDFInstance.setFont.mockReset();
    jsPDFInstance.setFontSize.mockReset();
    jsPDFInstance.setTextColor.mockReset();
    jsPDFInstance.setDrawColor.mockReset();
    jsPDFInstance.text.mockReset();
    jsPDFInstance.line.mockReset();
    jsPDFInstance.addPage.mockReset();
    jsPDFInstance.splitTextToSize.mockReset().mockReturnValue(['line1']);
    jsPDFInstance.output.mockReset().mockReturnValue(new ArrayBuffer(8));
    jsPDFInstance.internal.pageSize.getWidth.mockReset().mockReturnValue(210);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('returns 404 when meeting does not exist', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(null as never);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Meeting not found');
  });

  it('returns 404 when minutes do not exist for the meeting', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(FAKE_MEETING as never);
    mockQueryOne.mockResolvedValueOnce(null as never);

    const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('No minutes found');
  });

  it('returns 400 for an unknown format', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(FAKE_MEETING as never);
    mockQueryOne.mockResolvedValueOnce(FAKE_MINUTES_ROW as never);

    const req = makeJsonReq(`${BASE_URL}?format=odt`, 'GET');
    const res = await GET(req, PARAMS);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown format');
  });

  it('queries the meeting with the correct user id and meeting id', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(FAKE_MEETING as never);
    mockQueryOne.mockResolvedValueOnce(FAKE_MINUTES_ROW as never);

    await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);

    const [userId, , params] = mockQueryOne.mock.calls[0];
    expect(userId).toBe('user-123');
    expect(params).toContain(MEETING_ID);
  });

  it('queries minutes ordered by version desc for the meeting', async () => {
    mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
    mockQueryOne.mockResolvedValueOnce(FAKE_MEETING as never);
    mockQueryOne.mockResolvedValueOnce(FAKE_MINUTES_ROW as never);

    await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);

    const [, sql, params] = mockQueryOne.mock.calls[1];
    expect(sql).toMatch(/ORDER BY version DESC/i);
    expect(params).toContain(MEETING_ID);
  });

  describe('PDF export', () => {
    it('defaults to pdf format when no format param is given', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MEETING as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MINUTES_ROW as never);

      const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/pdf');
    });

    it('returns pdf when format=pdf is explicit', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MEETING as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MINUTES_ROW as never);

      const res = await GET(makeJsonReq(`${BASE_URL}?format=pdf`, 'GET'), PARAMS);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/pdf');
    });

    it('sets Content-Disposition to attachment with filename referat.pdf', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MEETING as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MINUTES_ROW as never);

      const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);

      expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="referat.pdf"');
    });

    it('renders empty-content sections with fallback text', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MEETING as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MINUTES_ROW as never);

      const res = await GET(makeJsonReq(BASE_URL, 'GET'), PARAMS);

      expect(res.status).toBe(200);
      const textCalls = jsPDFInstance.text.mock.calls.map(([t]: [string]) => t);
      expect(textCalls).toContain('(ingen indhold)');
    });
  });

  describe('DOCX export', () => {
    it('returns docx when format=docx', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MEETING as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MINUTES_ROW as never);

      const res = await GET(makeJsonReq(`${BASE_URL}?format=docx`, 'GET'), PARAMS);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
    });

    it('sets Content-Disposition to attachment with filename referat.docx', async () => {
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MEETING as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MINUTES_ROW as never);

      const res = await GET(makeJsonReq(`${BASE_URL}?format=docx`, 'GET'), PARAMS);

      expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="referat.docx"');
    });

    it('builds one paragraph per non-empty content line', async () => {
      const content = {
        sections: [{ key: 'k', label: 'Label', content: 'Line one\nLine two' }],
      };
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MEETING as never);
      mockQueryOne.mockResolvedValueOnce({ content, version: 1 } as never);

      await GET(makeJsonReq(`${BASE_URL}?format=docx`, 'GET'), PARAMS);

      const textRunCalls = MockTextRun.mock.calls;
      const contentTexts = textRunCalls
        .map(([opts]: [{ text: string }]) => opts.text)
        .filter(Boolean);
      expect(contentTexts).toContain('Line one');
      expect(contentTexts).toContain('Line two');
      expect(MockParagraph.mock.calls.length).toBeGreaterThan(0);
    });

    it('uses fallback text for empty content sections', async () => {
      const content = {
        sections: [{ key: 'k', label: 'Label', content: '' }],
      };
      mockGetSession.mockResolvedValueOnce(FAKE_SESSION as never);
      mockQueryOne.mockResolvedValueOnce(FAKE_MEETING as never);
      mockQueryOne.mockResolvedValueOnce({ content, version: 1 } as never);

      await GET(makeJsonReq(`${BASE_URL}?format=docx`, 'GET'), PARAMS);

      const texts = MockTextRun.mock.calls.map(([opts]: [{ text: string }]) => opts.text);
      expect(texts).toContain('(ingen indhold)');
    });
  });
});

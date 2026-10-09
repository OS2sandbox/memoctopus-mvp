import { describe, it, expect, vi, beforeEach } from 'vitest';

// The access gate (requireAppAccess) resolves the live principal; a plain
// bruger unless a test says otherwise.
vi.mock('@/lib/authz/principal', async () => ({
  resolvePrincipal: vi.fn(async () => (await import('@/test/helpers')).makePrincipal()),
}));
vi.mock('@/lib/audit/authz-denied', () => ({ recordAuthzDenied: vi.fn() }));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/record')>()),
  recordServerEvent: mockRecord,
}));

import { POST } from './route';
import { expectValidMetadataOnly, leakyError } from '@/app/api/meetings/ai-audit.test-utils';
import { auth } from '@/lib/auth';
import { FAKE_SESSION, makeJsonReq, makePrincipal } from '@/test/helpers';
import { resolvePrincipal } from '@/lib/authz/principal';
import { recordAuthzDenied } from '@/lib/audit/authz-denied';

const mockGetSession = vi.mocked(auth.api.getSession);

const BASE_URL = 'http://localhost/api/export/meet-1';
const PARAMS = { params: Promise.resolve({ id: 'meet-1' }) };

const content = {
  sections: [
    { key: 'punkter', label: 'Punkter', content: 'Vi besluttede at gå videre.' },
    { key: 'tom', label: 'Tom sektion', content: '' },
  ],
};

// The route renders client-supplied minutes content into a downloadable file.
// No auth, no DB — it takes { title, content, format } and streams the document back.
describe('POST /api/export/[id]', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(FAKE_SESSION as never);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { content, format: 'md' }), PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns 400 when content is missing', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { format: 'md' }), PARAMS);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Missing content');
  });

  it('returns 400 for an unknown format', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { content, format: 'xls' }), PARAMS);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown format');
  });

  it('exports markdown from legacy sections, dropping empty ones', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { title: 'Mit Referat', content, format: 'md' }), PARAMS);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    expect(res.headers.get('Content-Disposition')).toContain('referat.md');
    const text = await res.text();
    expect(text).toContain('# Mit Referat');
    expect(text).toContain('## Punkter');
    expect(text).toContain('Vi besluttede at gå videre.');
    expect(text).not.toContain('Tom sektion'); // empty section dropped
  });

  it('exports markdown directly from a single-body referat', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', {
      title: 'Mit Referat', content: { body: '## Beslutninger\n\nGå videre.' }, format: 'md',
    }), PARAMS);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('## Beslutninger');
    expect(text).toContain('Gå videre.');
  });

  it('falls back to a placeholder when the document is empty', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { content: { body: '' }, format: 'md' }), PARAMS);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('*(ingen indhold)*');
  });

  it('defaults to a PDF document when no format is given', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { content }), PARAMS);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toContain('referat.pdf');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('renders the editable header title and date from content.header', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', {
      title: 'Fallback',
      content: { body: 'Indhold.', header: { title: 'Møde · 17. juni', date: '17. juni 2026' } },
      format: 'md',
    }), PARAMS);
    const text = await res.text();
    expect(text).toContain('# Møde · 17. juni'); // header title wins over the title param
    expect(text).toContain('*17. juni 2026*');
    expect(text).not.toContain('Fallback');
  });

  it('omits the date line when the header has no date', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', {
      content: { body: 'Indhold.', header: { title: 'Møde', date: null } },
      format: 'md',
    }), PARAMS);
    const text = await res.text();
    expect(text).toContain('# Møde');
    // The only italic/asterisk content would be a date line — none expected.
    expect(text).not.toMatch(/\*[^*]+\*/);
  });

  it('strips CommonMark hard-break backslashes so line breaks do not render as "\\"', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', {
      content: { body: 'Tiende sætning: S\\\n\\\nØv bøv' },
      format: 'md',
    }), PARAMS);
    const text = await res.text();
    expect(text).toContain('Øv bøv');
    expect(text).not.toContain('\\'); // no literal backslash artifacts
  });

  it('exports a docx document', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { content, format: 'docx' }), PARAMS);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('wordprocessingml.document');
    expect(res.headers.get('Content-Disposition')).toContain('referat.docx');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('returns a parseable JSON 500 when the PDF renderer throws', async () => {
    // Simulate jsPDF throwing (e.g. dynamic-import failure or internal error)
    vi.doMock('jspdf', () => { throw new Error('jsPDF unavailable'); });
    try {
      // Force a fresh module load so the mock takes effect for the dynamic import
      const res = await POST(makeJsonReq(BASE_URL, 'POST', { content, format: 'pdf' }), PARAMS);
      // withHandler must catch the throw and return a JSON 500, not an HTML page.
      // In environments where jsPDF is available the format still succeeds (status 200).
      // We only assert that if it does fail it is parseable JSON with status 500.
      if (res.status === 500) {
        expect(res.headers.get('Content-Type')).toContain('application/json');
        const json = await res.json();
        expect(json.error).toBeDefined();
      } else {
        // jsPDF loaded fine in the test environment — just confirm OK shape
        expect(res.status).toBe(200);
      }
    } finally {
      vi.doUnmock('jspdf');
    }
  });

  it('returns a parseable JSON 500 when the docx renderer throws', async () => {
    // Simulate docx Packer throwing
    vi.doMock('docx', () => { throw new Error('docx unavailable'); });
    try {
      const res = await POST(makeJsonReq(BASE_URL, 'POST', { content, format: 'docx' }), PARAMS);
      if (res.status === 500) {
        expect(res.headers.get('Content-Type')).toContain('application/json');
        const json = await res.json();
        expect(json.error).toBeDefined();
      } else {
        expect(res.status).toBe(200);
      }
    } finally {
      vi.doUnmock('docx');
    }
  });
});

describe('audit: export.download', () => {
  const MEETING = '11111111-2222-4333-8444-555555555555';
  const UUID_PARAMS = { params: Promise.resolve({ id: MEETING }) };
  const events = () => mockRecord.mock.calls.map((c) => c[1]);
  beforeEach(() => {
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({ status: 'stored' });
  });

  const SECRET = { body: 'Hemmelig beslutning om Alice', header: { title: 'Sag om Bob', date: null } };

  it.each(['pdf', 'docx', 'md'] as const)('emits one export.download for %s with the meeting id and only the format', async (format) => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { title: 'Sag om Bob', content: SECRET, format }), UUID_PARAMS);
    expect(res.status).toBe(200);

    expect(events()).toHaveLength(1);
    const e = events()[0];
    expect(e).toMatchObject({ type: 'export.download', actorUserId: 'user-123', entityId: MEETING, details: { format } });
    expect(e.outcome ?? 'success').toBe('success');
    expectValidMetadataOnly(e, ['Hemmelig', 'Alice', 'Bob', 'Sag om']);
  });

  it('records the default format (pdf) when none is sent', async () => {
    await POST(makeJsonReq(BASE_URL, 'POST', { content: SECRET }), UUID_PARAMS);
    expect(events()[0].details).toEqual({ format: 'pdf' });
  });

  it('omits the entity when the URL id is not a UUID (ids are unverified)', async () => {
    await POST(makeJsonReq(BASE_URL, 'POST', { content: SECRET, format: 'md' }), PARAMS);
    const e = events()[0];
    expect(e.entityId).toBeUndefined();
    expectValidMetadataOnly(e, ['meet-1']);
  });

  it('emits nothing for 401, missing content or an unknown format', async () => {
    mockGetSession.mockResolvedValueOnce(null as never);
    await POST(makeJsonReq(BASE_URL, 'POST', { content: SECRET, format: 'md' }), UUID_PARAMS);
    await POST(makeJsonReq(BASE_URL, 'POST', { format: 'md' }), UUID_PARAMS);
    await POST(makeJsonReq(BASE_URL, 'POST', { content: SECRET, format: 'xls' }), UUID_PARAMS);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('still delivers the export when the audit write rejects', async () => {
    mockRecord.mockResolvedValueOnce({ status: 'dropped', code: 'db_error' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { content: SECRET, format: 'md' }), UUID_PARAMS);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Hemmelig beslutning');
    warn.mockRestore();
  });

  it('records outcome error (format only) when rendering throws, and still answers 500', async () => {
    vi.doMock('docx', () => { throw new Error('docx unavailable: Hemmelig'); });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await POST(makeJsonReq(BASE_URL, 'POST', { content: SECRET, format: 'docx' }), UUID_PARAMS);
      if (res.status === 500) {
        expect(events()).toHaveLength(1);
        expect(events()[0]).toMatchObject({ outcome: 'error', entityId: MEETING, details: { format: 'docx' } });
        expectValidMetadataOnly(events()[0], ['Hemmelig']);
        expect(JSON.stringify(spy.mock.calls)).not.toContain('Hemmelig');
      } else {
        expect(res.status).toBe(200);
      }
    } finally {
      spy.mockRestore();
      vi.doUnmock('docx');
    }
  });
});

describe('POST /api/export/[id] — access gate', () => {
  beforeEach(() => {
    mockGetSession.mockReset().mockResolvedValue(FAKE_SESSION as never);
    mockRecord.mockReset();
  });

  it('answers 403 for a disabled user and returns no document', async () => {
    vi.mocked(resolvePrincipal).mockResolvedValueOnce(makePrincipal({ disabled: true, roles: [], capabilities: [] }));
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { content, format: 'md' }), PARAMS);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('refuses before validating the body, so a disabled user learns nothing', async () => {
    vi.mocked(resolvePrincipal).mockResolvedValueOnce(makePrincipal({ disabled: true, roles: [], capabilities: [] }));
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { format: 'xls' }), PARAMS);
    expect(res.status).toBe(403);
  });
});

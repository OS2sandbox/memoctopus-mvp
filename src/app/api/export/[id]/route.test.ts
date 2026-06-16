import { describe, it, expect } from 'vitest';
import { POST } from './route';
import { makeJsonReq } from '@/test/helpers';

const BASE_URL = 'http://localhost/api/export/meet-1';

const content = {
  sections: [
    { key: 'punkter', label: 'Punkter', content: 'Vi besluttede at gå videre.' },
    { key: 'tom', label: 'Tom sektion', content: '' },
  ],
};

// The route renders client-supplied minutes content into a downloadable file.
// No auth, no DB — it takes { title, content, format } and streams the document back.
describe('POST /api/export/[id]', () => {
  it('returns 400 when content is missing', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { format: 'md' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Missing content');
  });

  it('returns 400 for an unknown format', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { content, format: 'xls' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown format');
  });

  it('exports markdown from legacy sections, dropping empty ones', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { title: 'Mit Referat', content, format: 'md' }));

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
    }));

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('## Beslutninger');
    expect(text).toContain('Gå videre.');
  });

  it('falls back to a placeholder when the document is empty', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { content: { body: '' }, format: 'md' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('*(ingen indhold)*');
  });

  it('defaults to a PDF document when no format is given', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { content }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toContain('referat.pdf');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('exports a docx document', async () => {
    const res = await POST(makeJsonReq(BASE_URL, 'POST', { content, format: 'docx' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('wordprocessingml.document');
    expect(res.headers.get('Content-Disposition')).toContain('referat.docx');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});

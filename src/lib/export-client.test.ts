// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadExport } from './export-client';

const OPTIONS = {
  meetingId: 'mtg-1',
  title: 'Møde',
  content: { body: 'Tekst' },
  format: 'docx' as const,
  filename: 'referat.docx',
};

let clicked: HTMLAnchorElement[];

beforeEach(() => {
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
  URL.createObjectURL = vi.fn().mockReturnValue('blob:fake');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('downloadExport', () => {
  it('posts the document to the export route and saves the reply under the filename', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('docx-bytes', { status: 200 }));

    await downloadExport(OPTIONS);

    expect(global.fetch).toHaveBeenCalledWith('/api/export/mtg-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Møde', content: { body: 'Tekst' }, format: 'docx' }),
    });
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('referat.docx');
    expect(clicked[0].href).toBe('blob:fake');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('rejects with the server error message and downloads nothing', async () => {
    global.fetch = vi.fn().mockResolvedValue(Response.json({ error: 'Missing content' }, { status: 400 }));

    await expect(downloadExport(OPTIONS)).rejects.toThrow('Missing content');
    expect(clicked).toHaveLength(0);
  });

  it.each([
    ['a JSON body without an error field', () => Response.json({}, { status: 500 })],
    ['a body that is not JSON', () => new Response('<html>Bad Gateway</html>', { status: 502 })],
  ])('falls back to "Eksport fejlede" for %s', async (_case, reply) => {
    global.fetch = vi.fn().mockResolvedValue(reply());

    await expect(downloadExport(OPTIONS)).rejects.toThrow('Eksport fejlede');
    expect(clicked).toHaveLength(0);
  });
});

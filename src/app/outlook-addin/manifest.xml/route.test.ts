import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET } from './route';
import { DEFAULT_ADDIN_ID } from '@/lib/outlook/manifest';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const saved = { ...process.env };

beforeEach(() => {
  process.env.OUTLOOK_ADDIN_ENABLED = 'true';
  process.env.TEAMS_GRAPH_ENABLED = 'true';
  process.env.MICROSOFT_CLIENT_ID = CLIENT;
  process.env.MICROSOFT_CLIENT_SECRET = 'secret';
  process.env.MICROSOFT_TENANT_ID = TENANT;
  process.env.BETTER_AUTH_URL = 'https://taletiltekst.example.dk';
  delete process.env.MICROSOFT_ENABLED;
  delete process.env.OUTLOOK_ADDIN_ID;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe('GET /outlook-addin/manifest.xml', () => {
  it('hands out the manifest as a file to upload, never cached', async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="os2taletiltekst-outlook.xml"');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const xml = await res.text();
    expect(xml).toContain('<SourceLocation DefaultValue="https://taletiltekst.example.dk/outlook-addin/taskpane.html"/>');
    expect(xml).toContain(`<Id>${DEFAULT_ADDIN_ID}</Id>`);
  });

  it('is not there while the add-in is off', async () => {
    delete process.env.OUTLOOK_ADDIN_ENABLED;
    const res = await GET();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'disabled' });
  });

  it.each([
    ['unset', undefined],
    ['plain http', 'http://taletiltekst.example.dk'],
    ['a path', 'https://taletiltekst.example.dk/app'],
  ])('refuses to build a manifest when BETTER_AUTH_URL is %s', async (_name, url) => {
    if (url === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = url;

    const res = await GET();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'misconfigured' });
    expect(console.error).toHaveBeenCalled();
  });

  it('uses OUTLOOK_ADDIN_ID, so a second deployment in the tenant is a separate add-in', async () => {
    process.env.OUTLOOK_ADDIN_ID = '6F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9';
    const xml = await (await GET()).text();
    expect(xml).toContain('<Id>6f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9</Id>');
    expect(xml).not.toContain(DEFAULT_ADDIN_ID);
  });

  it('refuses an OUTLOOK_ADDIN_ID that is not a GUID rather than fall back to the shared one', async () => {
    process.env.OUTLOOK_ADDIN_ID = 'staging';
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'misconfigured' });
  });
});

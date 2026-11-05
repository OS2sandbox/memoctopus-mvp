import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ADDIN_VERSION, DEFAULT_ADDIN_ID, addinId, buildManifest } from './manifest';

const saved = { ...process.env };

beforeEach(() => {
  delete process.env.OUTLOOK_ADDIN_ID;
});

afterEach(() => {
  process.env = { ...saved };
});

describe('buildManifest', () => {
  const xml = buildManifest('https://taletiltekst.example.dk');

  it('points every URL at the given origin', () => {
    const urls = [...xml.matchAll(/https:\/\/[^"<\s]+/g)].map((m) => m[0])
      .filter((u) => !u.startsWith('https://schemas.microsoft.com') && !u.startsWith('http://www.w3.org'));
    expect(urls.length).toBeGreaterThan(5);
    for (const u of urls) expect(u.startsWith('https://taletiltekst.example.dk')).toBe(true);
    expect(xml).toContain('<SourceLocation DefaultValue="https://taletiltekst.example.dk/outlook-addin/taskpane.html"/>');
    expect(xml).toContain('<AppDomain>https://taletiltekst.example.dk</AppDomain>');
  });

  it('keeps the fixed id, so the admin updates the add-in instead of adding a second one', () => {
    expect(DEFAULT_ADDIN_ID).toBe('3b8720fe-bdc3-4a89-ab8b-f35412c768bd');
    expect(xml).toContain(`<Id>${DEFAULT_ADDIN_ID}</Id>`);
    expect(xml).toContain(`<Version>${ADDIN_VERSION}</Version>`);
    expect(ADDIN_VERSION).toBe('1.1.0.0');
    expect(xml).toContain('<DisplayName DefaultValue="OS2taletiltekst"/>');
  });

  it('is an online-meeting provider: one function command on the organizer form, beside the pane button', () => {
    expect(xml).toContain('xsi:type="VersionOverridesV1_1"');
    expect(xml.match(/xsi:type="ExecuteFunction"/g)).toHaveLength(1);
    expect(xml).toContain('<FunctionName>insertOs2Meeting</FunctionName>');
    expect(xml).toContain('<FunctionFile resid="Commands.Url"/>');
    expect(xml).toContain('DefaultValue="https://taletiltekst.example.dk/outlook-addin/commands.html"');
    // The pane button in both overrides: older clients get it alone.
    expect(xml.match(/id="os2taletiltekst.armButton"/g)).toHaveLength(2);
    expect(xml).toContain('AppointmentOrganizerCommandSurface');
    expect(xml).not.toContain('LaunchEvent');
  });

  it('may write to the item it is opened on, and no more', () => {
    expect(xml).toContain('<Permissions>ReadWriteItem</Permissions>');
    expect(xml).not.toContain('ReadWriteMailbox');
  });

  it('drops a trailing slash but refuses anything that is not a bare https origin', () => {
    expect(buildManifest('https://taletiltekst.example.dk/')).toBe(xml);
    expect(() => buildManifest('http://taletiltekst.example.dk')).toThrow();
    expect(() => buildManifest('https://taletiltekst.example.dk/app')).toThrow();
    expect(() => buildManifest('https://taletiltekst.example.dk/?x=1')).toThrow();
    expect(() => buildManifest('')).toThrow();
  });

  // The admin center keeps the file it was given, and Outlook updates an add-in
  // only when its version goes up. If this fails, the manifest changed: bump
  // ADDIN_VERSION in manifest.ts, then set both values below to the new ones.
  // Never update the hash alone.
  const PINNED = {
    version: '1.1.0.0',
    sha256: '86ef7e051401b43acae45cf3b52511110adaf0456dc9954afdc90c11db0b3e7e',
  };

  it('changes only together with ADDIN_VERSION', () => {
    const sha256 = createHash('sha256').update(xml).digest('hex');
    expect(
      { version: ADDIN_VERSION, sha256 },
      'The manifest changed. Bump ADDIN_VERSION in src/lib/outlook/manifest.ts, then update ' +
        'PINNED in this test to the new version and hash, and tell the admin to upload the new file.',
    ).toEqual(PINNED);
  });
});

describe('addinId', () => {
  it('is the id the add-in shipped with unless OUTLOOK_ADDIN_ID is set', () => {
    expect(addinId()).toBe(DEFAULT_ADDIN_ID);
    process.env.OUTLOOK_ADDIN_ID = '  ';
    expect(addinId()).toBe(DEFAULT_ADDIN_ID);
  });

  it('takes OUTLOOK_ADDIN_ID, lowercased', () => {
    process.env.OUTLOOK_ADDIN_ID = '6F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9';
    expect(addinId()).toBe('6f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9');
    expect(buildManifest('https://taletiltekst.example.dk')).toContain('<Id>6f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9</Id>');
  });

  it('refuses an OUTLOOK_ADDIN_ID that is not a GUID', () => {
    process.env.OUTLOOK_ADDIN_ID = 'staging';
    expect(() => addinId()).toThrow(/OUTLOOK_ADDIN_ID/);
    expect(() => buildManifest('https://taletiltekst.example.dk')).toThrow(/OUTLOOK_ADDIN_ID/);
  });
});

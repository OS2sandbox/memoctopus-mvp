import { describe, it, expect } from 'vitest';
import { ADDIN_ID, ADDIN_VERSION, buildManifest } from './manifest';

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
    expect(ADDIN_ID).toBe('3b8720fe-bdc3-4a89-ab8b-f35412c768bd');
    expect(xml).toContain(`<Id>${ADDIN_ID}</Id>`);
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
});

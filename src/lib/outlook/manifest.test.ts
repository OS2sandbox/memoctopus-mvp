import { describe, it, expect } from 'vitest';
import { ADDIN_ID, TEST_ADDIN_ID, buildManifest } from './manifest';

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

  it('keeps the fixed id and the lowest permission', () => {
    expect(xml).toContain(`<Id>${ADDIN_ID}</Id>`);
    expect(xml).toContain('<Permissions>ReadItem</Permissions>');
    expect(xml).toContain('AppointmentOrganizerCommandSurface');
  });

  it('drops a trailing slash but refuses anything that is not a bare https origin', () => {
    expect(buildManifest('https://taletiltekst.example.dk/')).toBe(xml);
    expect(() => buildManifest('http://taletiltekst.example.dk')).toThrow();
    expect(() => buildManifest('https://taletiltekst.example.dk/app')).toThrow();
    expect(() => buildManifest('https://taletiltekst.example.dk/?x=1')).toThrow();
    expect(() => buildManifest('')).toThrow();
  });
});

describe('buildManifest, test variant', () => {
  const prod = buildManifest('https://taletiltekst.example.dk');
  const xml = buildManifest('https://taletiltekst.example.dk', 'test');

  it('is a separate add-in, so it can sit next to the real one', () => {
    expect(TEST_ADDIN_ID).not.toBe(ADDIN_ID);
    expect(xml).toContain(`<Id>${TEST_ADDIN_ID}</Id>`);
    expect(xml).not.toContain(ADDIN_ID);
    expect(xml).toContain('<DisplayName DefaultValue="OS2taletiltekst (test)"/>');
  });

  it('adds the send event, in a 1.12 override, that never blocks a send outright', () => {
    expect(xml).toContain('xsi:type="VersionOverridesV1_1"');
    expect(xml).toContain('<bt:Sets DefaultMinVersion="1.12">');
    expect(xml).toContain('<LaunchEvent Type="OnAppointmentSend" FunctionName="onAppointmentSendProbe" SendMode="PromptUser"/>');
    expect(xml).toContain('DefaultValue="https://taletiltekst.example.dk/outlook-addin/commands.html"');
    expect(xml).toContain('DefaultValue="https://taletiltekst.example.dk/outlook-addin/commands.js"');
    expect(xml).toContain('<Permissions>ReadItem</Permissions>');
  });

  it('leaves the production manifest without any of it', () => {
    expect(prod).not.toContain('LaunchEvent');
    expect(prod).not.toContain('VersionOverridesV1_1');
    expect(prod).not.toContain('commands.');
  });
});

import { describe, it, expect } from 'vitest';
import { ADDIN_ID, buildManifest } from './manifest';

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

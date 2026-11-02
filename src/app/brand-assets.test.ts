import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

// next/font only works inside a Next build.
vi.mock('geist/font/sans', () => ({ GeistSans: { variable: 'font-sans' } }));
vi.mock('geist/font/mono', () => ({ GeistMono: { variable: 'font-mono' } }));

import { metadata } from './layout';

const PUBLIC = path.resolve(__dirname, '../../public');

type IconEntry = { url: string; type?: string; sizes?: string };
const icons = metadata.icons as { icon: IconEntry[]; apple: IconEntry[] };

describe('root metadata — name and icons', () => {
  it('names the product, nothing more', () => {
    expect(metadata.title).toBe('OS2taletiltekst');
  });

  it('has a single favicon, and it exists', () => {
    expect(icons.icon).toHaveLength(1);
    expect(existsSync(path.join(PUBLIC, icons.icon[0].url))).toBe(true);
    // In Next 15, icons set here win over app/icon.*, which would only be a stray copy.
    expect(existsSync(path.resolve(__dirname, 'icon.svg'))).toBe(false);
  });

  it('draws the favicon light on dark browser chrome', () => {
    const svg = readFileSync(path.join(PUBLIC, icons.icon[0].url), 'utf8');
    expect(svg).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
  });

  // iOS ignores an SVG apple-touch-icon and paints transparent pixels black.
  it('gives iOS an opaque 180×180 PNG home-screen icon', () => {
    expect(icons.apple).toHaveLength(1);
    const png = readFileSync(path.join(PUBLIC, icons.apple[0].url));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(180); // IHDR width
    expect(png.readUInt32BE(20)).toBe(180); // IHDR height
    expect(png[25]).toBe(2); // colour type 2: RGB, no alpha channel
  });
});

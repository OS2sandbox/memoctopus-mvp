#!/usr/bin/env node
// Renders the add-in's icons (outlook-addin/assets/icon-*.png) from the OS2 mark.
// Run by hand when the logo changes, and commit the PNGs:
//
//   node outlook-addin/make-icons.mjs [path/to/mark.svg]   (default public/favicon.svg)
//
// The mark is near-black, which vanishes on Outlook's dark ribbon, so it sits
// on a white rounded tile with a thin grey edge: legible in light and dark.
// Only the mark, never the "taletiltekst" lockup: that text cannot be read at
// the 16-80 px Outlook draws ribbon icons at.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2] ?? join(here, '..', 'public', 'favicon.svg');
const SIZES = [16, 32, 64, 80, 128];

const svg = await readFile(source, 'utf8');
const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
if (!viewBox) throw new Error(`${source} has no viewBox`);
// The shapes only: no <title>, and no dark-mode <style> (the tile is always white).
const shapes = [...svg.matchAll(/<(path|rect)\b[^>]*\/>/g)].map((m) => m[0]).join('');
if (!shapes) throw new Error(`${source} has no <path>/<rect> shapes`);

function tile(size) {
  // Small icons need relatively more of the tile for the mark to stay legible.
  const pad = size <= 16 ? 6 : size <= 32 ? 9 : 12;
  const inner = 100 - 2 * pad;
  const edge = size <= 16 ? 0 : 1.5;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect x="${edge / 2}" y="${edge / 2}" width="${100 - edge}" height="${100 - edge}" rx="20" fill="#FFFFFF"
        ${edge ? `stroke="#D1D1D1" stroke-width="${edge}"` : ''}/>
  <svg x="${pad}" y="${pad}" width="${inner}" height="${inner}" viewBox="${viewBox}">${shapes}</svg>
</svg>`;
}

for (const size of SIZES) {
  const out = join(here, 'assets', `icon-${size}.png`);
  await sharp(Buffer.from(tile(size)), { density: 72 * 4 }).resize(size, size).png().toFile(out);
  console.log(`wrote ${out}`);
}

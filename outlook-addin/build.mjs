#!/usr/bin/env node
// Builds the Outlook add-in's task pane into public/outlook-addin/, where Next
// serves it as static files (https://<host>/outlook-addin/taskpane.html). Runs as
// part of `npm run build`. The manifest is not built here: the server generates
// it per deployment at /outlook-addin/manifest.xml (src/lib/outlook/manifest.ts).
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const out = join(repo, 'public', 'outlook-addin');
const buildId = Date.now().toString(36);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: { taskpane: join(here, 'src', 'taskpane.ts') },
  outdir: out,
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  // Outlook's add-in webviews are Edge WebView2 / WKWebView / current browsers.
  target: ['es2020'],
  tsconfig: join(repo, 'tsconfig.json'),
  logLevel: 'warning',
});

// The build id busts Outlook's cache of taskpane.js after a deploy.
const html = (await readFile(join(here, 'src', 'taskpane.html'), 'utf8')).replaceAll('__BUILD_ID__', buildId);
await writeFile(join(out, 'taskpane.html'), html);
await cp(join(here, 'assets'), join(out, 'assets'), { recursive: true });

console.log(`Outlook add-in built into public/outlook-addin/ (${buildId})`);

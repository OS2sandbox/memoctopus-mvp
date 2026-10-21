// Central templates are locked: the personal-template routes operate on the per-user
// `skabeloner` table only, so they must never reach the central modules (a central
// prompt could otherwise be copied out through share/import or edited in place).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

describe('personal skabelon route sources', () => {
  const ROOT = path.resolve(__dirname);
  const routeFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) return routeFiles(p);
      return f === 'route.ts' ? [p] : [];
    });

  const files = routeFiles(ROOT);

  it('finds the personal route files', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('only the list route (GET, summaries without prompt) may import the central resolver; nothing imports the manager service', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      expect(src, rel).not.toMatch(/skabeloner\/central['"]/);
      expect(src, rel).not.toMatch(/central-schemas/);
      if (rel !== 'route.ts') expect(src, rel).not.toMatch(/skabeloner\/resolve['"]/);
    }
  });

  it('the list route imports only listCentralForUser, never resolveCentralTemplate (the prompt-carrying read)', () => {
    const src = readFileSync(path.join(ROOT, 'route.ts'), 'utf8');
    expect(src).toMatch(/listCentralForUser/);
    expect(src).not.toMatch(/resolveCentralTemplate/);
  });
});

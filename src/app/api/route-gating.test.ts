// "Every route is gated" (CLAUDE.md): a route either runs through withAuthz /
// requireAppAccess (session, live principal, refusal of a disabled or role-less
// person) or is on the short exempt list below. A new route that checks only the
// session fails here.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname);

const routeFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return f === 'route.ts' ? [p] : [];
  });

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

describe('API route gating', () => {
  const files = routeFiles(ROOT);

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('every route uses withAuthz or requireAppAccess, unless it is exempt', () => {
    const ungated = files
      .filter((f) => {
        const r = rel(f);
        if (r === 'health/route.ts' || r.startsWith('auth/')) return false;
        if (r.startsWith('internal/')) return false; // secret-authenticated, below
        const src = readFileSync(f, 'utf8');
        return !/\b(withAuthz|requireAppAccess)\b/.test(src);
      })
      .map(rel);
    expect(ungated).toEqual([]);
  });

  it('every internal route is behind the cron secret', () => {
    const internal = files.filter((f) => rel(f).startsWith('internal/'));
    expect(internal.length).toBeGreaterThan(0);
    for (const f of internal) expect(readFileSync(f, 'utf8'), rel(f)).toMatch(/\bcronGuard\b/);
  });
});

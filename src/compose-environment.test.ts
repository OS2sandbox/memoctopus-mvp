import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// The app container receives ONLY the variables listed in docker-compose.yml's
// app.environment: there is no env_file, so a variable the code reads but compose does
// not pass is silently unset in production, however carefully the operator fills in
// .env. This guard finds the variables server code reads and checks compose passes them.
//
// What it finds: `process.env.NAME`, `process.env['NAME']`, and a quoted name handed to
// the `env('NAME')` / `flag('NAME')` helpers in src/lib/auth/providers.ts. A name built at
// runtime (providers.ts's `${prefix}_CLIENT_ID`) is invisible to it.

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');

// Read by the code but never set by an operator, so compose has no business passing them.
const NOT_OPERATOR_SETTINGS: Record<string, string> = {
  NODE_ENV: 'set by Next.js and the Dockerfile',
  NEXT_RUNTIME: 'set by Next.js for each runtime (instrumentation.ts)',
  VITEST: 'set by the test runner; switches background jobs off under test',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) {
      return [];
    }
    return [full];
  });
}

function variablesReadBy(files: string[]): Map<string, string> {
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
    /\b(?:env|flag)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  ];
  const found = new Map<string, string>(); // name → first file reading it
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        if (!found.has(m[1])) found.set(m[1], path.relative(ROOT, file));
      }
    }
  }
  return found;
}

// The names in the `app` service's `environment:` list. A line-based read of the one block
// we need; the file's own structure (two-space indents, `- NAME=value` items) is assumed.
function composeAppEnvironment(): Set<string> {
  const lines = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8').split('\n');
  const app = lines.findIndex((l) => l === '  app:');
  expect(app, 'docker-compose.yml has an `app` service').toBeGreaterThan(-1);
  const names = new Set<string>();
  let inEnvironment = false;
  for (const line of lines.slice(app + 1)) {
    if (/^ {2}\S/.test(line) || /^\S/.test(line)) break; // next service or top-level key
    if (/^ {4}\S/.test(line)) inEnvironment = line.trim() === 'environment:';
    const item = inEnvironment && line.match(/^ {6}- ([A-Z][A-Z0-9_]*)=/);
    if (item) names.add(item[1]);
  }
  return names;
}

describe('docker-compose.yml passes the app every variable it reads', () => {
  const read = variablesReadBy(sourceFiles(SRC));
  const passed = composeAppEnvironment();

  it('finds the variables at all', () => {
    // Guards the guard: a broken scan would make the next test pass vacuously.
    expect(read.has('DATABASE_URL')).toBe(true);
    expect(read.has('TEAMS_GRAPH_ENABLED')).toBe(true); // via providers.ts's env()
    expect(passed.has('DATABASE_URL')).toBe(true);
  });

  it('lists each one in app.environment', () => {
    const missing = [...read]
      .filter(([name]) => !name.startsWith('NEXT_PUBLIC_') && !(name in NOT_OPERATOR_SETTINGS))
      .filter(([name]) => !passed.has(name))
      .map(([name, file]) => `${name} (read in ${file})`);

    expect(missing).toEqual([]);
  });
});

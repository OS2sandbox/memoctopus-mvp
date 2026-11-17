import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { ONBOARDING_STEPS } from './steps';

// Keeps steps.ts and the pages that reference it from drifting apart: a step
// nobody renders, a typo'd id (which findStep only logs at runtime), a popover
// step wrapped in a tooltip (never remembered) or the other way round.

const SRC = path.resolve(__dirname, '../..');
const ENGINE_OF = { OnboardingHint: 'popover', OnboardingTooltip: 'tooltip' } as const;
type Component = keyof typeof ENGINE_OF;

type Usage = { file: string; component: Component; attrs: string; stepId: string | null };

/** The attribute text of each opening `<Name …>` tag, skipping `>` inside `{…}` and quotes. */
function openingTags(source: string, name: string): string[] {
  const tags: string[] = [];
  const re = new RegExp(`<${name}\\b`, 'g');
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 0;
    let quote: string | null = null;
    let i = m.index + m[0].length;
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push(source.slice(m.index + m[0].length, i));
  }
  return tags;
}

function usages(): Usage[] {
  const files = (readdirSync(SRC, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
    .filter((f) => !f.startsWith(`components${path.sep}onboarding${path.sep}`));
  return files.flatMap((file) => {
    const source = readFileSync(path.join(SRC, file), 'utf8');
    return (Object.keys(ENGINE_OF) as Component[]).flatMap((component) =>
      openingTags(source, component).map((attrs) => ({
        file,
        component,
        attrs,
        stepId: /\bstepId="([^"]+)"/.exec(attrs)?.[1] ?? null,
      })),
    );
  });
}

describe('onboarding registry ↔ call sites', () => {
  const all = usages();

  it('finds the call sites at all', () => {
    expect(all.length).toBeGreaterThan(Object.keys(ONBOARDING_STEPS).length - 1);
  });

  it('passes every stepId as a string literal, so this test can check it', () => {
    expect(all.filter((u) => u.stepId === null).map((u) => `${u.file}: <${u.component}${u.attrs}>`)).toEqual([]);
  });

  it('uses only step ids that exist in steps.ts', () => {
    const unknown = all.filter((u) => u.stepId && !Object.hasOwn(ONBOARDING_STEPS, u.stepId));
    expect(unknown.map((u) => `${u.file}: ${u.stepId}`)).toEqual([]);
  });

  it('renders every registered step somewhere', () => {
    const used = new Set(all.map((u) => u.stepId));
    expect(Object.keys(ONBOARDING_STEPS).filter((id) => !used.has(id))).toEqual([]);
  });

  it('renders popover steps with OnboardingHint and tooltip steps with OnboardingTooltip', () => {
    const mismatched = all.filter(
      (u) => u.stepId && Object.hasOwn(ONBOARDING_STEPS, u.stepId) && ONBOARDING_STEPS[u.stepId].engine !== ENGINE_OF[u.component],
    );
    expect(mismatched.map((u) => `${u.file}: <${u.component} stepId="${u.stepId}">`)).toEqual([]);
  });

  // OnboardingHint ignores a meetingId at a global step, so passing one only
  // suggests a per-meeting behaviour the step does not have.
  it('passes a meetingId only to per-meeting steps', () => {
    const misleading = all.filter(
      (u) =>
        u.component === 'OnboardingHint' &&
        /\bmeetingId=/.test(u.attrs) &&
        u.stepId &&
        ONBOARDING_STEPS[u.stepId]?.scope !== 'per-meeting',
    );
    expect(misleading.map((u) => `${u.file}: ${u.stepId}`)).toEqual([]);
  });
});

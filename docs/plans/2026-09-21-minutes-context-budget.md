# Minutes Context Budget Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Never return a silently truncated referat: size the minutes prompt against a configurable context window, cap the output, and summarise long transcripts in parts.

**Architecture:** Two settings (`LLM_CONTEXT_TOKENS`, `LLM_MAX_OUTPUT_TOKENS`) feed a character budget. Pure helpers merge same-speaker segments and split turns into parts that fit the budget. `generateReferatBody` writes the referat in one call when the transcript fits, otherwise summarises the parts (3 at a time) and writes the referat from the summaries. Typed errors in their own module are mapped to Danish messages by the route.

**Tech Stack:** Next.js 15 route handlers, TypeScript, Vitest (`npx vitest run <file>`), OpenAI SDK v4 (`chat.completions.create`), Docker Compose.

**Spec:** `docs/specs/2026-09-21-minutes-context-budget-design.md`. Fixes #97.

**Conventions to know:**
- Tests live next to the code (`foo.ts` → `foo.test.ts`). Globals (`describe`, `it`) are enabled, but existing tests import them from `vitest` explicitly. Do the same.
- Env is read **inside functions**, never at module load (same idiom as `src/lib/auth/providers.ts`).
- Commit messages are Conventional Commits (a CI check enforces PR titles) and end with the attribution line shown in each commit step.
- Run everything from the repo root.

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/ai/llm-client.ts` | modify | export `usingHostedOpenAI()` |
| `src/lib/ai/llm-limits.ts` | create | limits from env, constants, `transcriptBudgetChars()` |
| `src/lib/ai/llm-limits.test.ts` | create | tests for the above |
| `src/lib/ai/transcript-text.ts` | create | `formatTime`, `mergeSpeakerTurns`, `renderTurns`, `splitTurns` (pure) |
| `src/lib/ai/transcript-text.test.ts` | create | tests for the above |
| `src/lib/ai/map-with-limit.ts` | create | bounded-concurrency `map` |
| `src/lib/ai/map-with-limit.test.ts` | create | tests for the above |
| `src/lib/ai/minutes-errors.ts` | create | three typed errors |
| `src/lib/ai/minutes.ts` | modify | budgeted generation flow |
| `src/lib/ai/minutes.test.ts` | modify | new tests for the flow |
| `src/app/api/minutes/route.ts` | modify | map typed errors to Danish JSON errors |
| `src/app/api/minutes/route.test.ts` | modify | tests for the mapping |
| `docker-compose.yml` | modify | pass both settings to the `app` service |
| `.env.example`, `.env.deploy.example`, `DEPLOY.md` | modify | document the settings |

---

### Task 1: Expose "hosted OpenAI" from the LLM client

**Files:**
- Modify: `src/lib/ai/llm-client.ts` (after `usingHostedApi`, around line 27)
- Test: `src/lib/ai/llm-client.test.ts`

The limits defaults depend on "real OpenAI" (key set **and** no `LLM_BASE_URL`), which is narrower than the existing private `usingHostedApi()`.

- [ ] **Step 1: Write the failing test**

Add to the imports at the top of `src/lib/ai/llm-client.test.ts` whatever already imports from `./llm-client` (add `usingHostedOpenAI` to that import list), then append this block at the end of the file:

```ts
describe('usingHostedOpenAI', () => {
  it('is false with no key and no base URL', () => {
    expect(usingHostedOpenAI()).toBe(false);
  });

  it('is true when only an API key is set', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    expect(usingHostedOpenAI()).toBe(true);
  });

  it('is false when LLM_BASE_URL points elsewhere, even with a key', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    process.env.LLM_BASE_URL = 'http://my-llm:8000/v1';
    expect(usingHostedOpenAI()).toBe(false);
  });

  it('treats a blank key as no key', () => {
    process.env.OPENAI_API_KEY = '   ';
    expect(usingHostedOpenAI()).toBe(false);
  });
});
```

(The file's existing `beforeEach` already resets `process.env` and deletes `OPENAI_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/ai/llm-client.test.ts`
Expected: FAIL. `usingHostedOpenAI is not a function` (or a TypeScript/import error).

- [ ] **Step 3: Implement**

In `src/lib/ai/llm-client.ts`, directly after the `usingHostedApi` function, add:

```ts
// True only for the real OpenAI API: a key is set and no custom base URL redirects it.
// Distinct from usingHostedApi(), which is also true for any custom LLM_BASE_URL.
export function usingHostedOpenAI(): boolean {
  return hasOpenAIKey() && !process.env.LLM_BASE_URL?.trim();
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/ai/llm-client.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/llm-client.ts src/lib/ai/llm-client.test.ts
git commit -m "refactor(ai): expose usingHostedOpenAI from the LLM client

Co-Authored-By: Claude <noreply@anthropic.com> via Dash <dash@syv.ai>"
```

---

### Task 2: LLM limits and the transcript budget

**Files:**
- Create: `src/lib/ai/llm-limits.ts`
- Test: `src/lib/ai/llm-limits.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ai/llm-limits.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLlmLimits, transcriptBudgetChars, CHARS_PER_TOKEN } from './llm-limits';

const ENV = process.env;

beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_CONTEXT_TOKENS;
  delete process.env.LLM_MAX_OUTPUT_TOKENS;
});

afterEach(() => {
  process.env = ENV;
});

describe('getLlmLimits defaults', () => {
  it('is conservative for self-hosted (no key, no base URL)', () => {
    expect(getLlmLimits()).toEqual({ contextTokens: 32_768, maxOutputTokens: 4_096 });
  });

  it('uses gpt-4o limits for hosted OpenAI', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    expect(getLlmLimits()).toEqual({ contextTokens: 128_000, maxOutputTokens: 16_384 });
  });

  it('stays conservative for a custom LLM_BASE_URL, even with a key', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    process.env.LLM_BASE_URL = 'http://my-llm:8000/v1';
    expect(getLlmLimits()).toEqual({ contextTokens: 32_768, maxOutputTokens: 4_096 });
  });
});

describe('getLlmLimits overrides', () => {
  it('reads LLM_CONTEXT_TOKENS and LLM_MAX_OUTPUT_TOKENS', () => {
    process.env.LLM_CONTEXT_TOKENS = '16384';
    process.env.LLM_MAX_OUTPUT_TOKENS = '2000';
    expect(getLlmLimits()).toEqual({ contextTokens: 16_384, maxOutputTokens: 2_000 });
  });

  it.each(['', '  ', 'abc', '0', '-5', '1.5'])('falls back to the default for %j', (bad) => {
    process.env.LLM_CONTEXT_TOKENS = bad;
    process.env.LLM_MAX_OUTPUT_TOKENS = bad;
    expect(getLlmLimits()).toEqual({ contextTokens: 32_768, maxOutputTokens: 4_096 });
  });
});

describe('transcriptBudgetChars', () => {
  it('subtracts output and fixed-prompt tokens, then converts to characters', () => {
    process.env.LLM_CONTEXT_TOKENS = '10000';
    process.env.LLM_MAX_OUTPUT_TOKENS = '2000';
    // 1000 fixed chars / 2.5 = 400 tokens; (10000 - 2000 - 400) * 2.5 = 19000
    expect(CHARS_PER_TOKEN).toBe(2.5);
    expect(transcriptBudgetChars(1000)).toBe(19_000);
  });

  it('can be negative when the context is too small', () => {
    process.env.LLM_CONTEXT_TOKENS = '1000';
    process.env.LLM_MAX_OUTPUT_TOKENS = '2000';
    expect(transcriptBudgetChars(0)).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/ai/llm-limits.test.ts`
Expected: FAIL. Cannot find module `./llm-limits`.

- [ ] **Step 3: Implement**

Create `src/lib/ai/llm-limits.ts`:

```ts
import { usingHostedOpenAI } from './llm-client';

// Context-window budgeting for chat-LLM calls (minutes generation).
//
// LLM_CONTEXT_TOKENS / LLM_MAX_OUTPUT_TOKENS describe the model the deployment points at.
// Real OpenAI gets gpt-4o's limits; any other endpoint (self-hosted vLLM, a custom
// LLM_BASE_URL) gets conservative defaults because its real window is unknown — operators
// with a different model set the variables. Env is read inside the function so a change
// takes effect on restart without a rebuild.

// Deliberately pessimistic for Danish (measured 2.33–2.97 chars/token; names, numbers and
// loanwords tokenise worse). Summarising a transcript that would have fit costs some
// quality; exceeding the window costs the whole request.
export const CHARS_PER_TOKEN = 2.5;

// Below this many characters of transcript budget the configuration cannot work.
export const MIN_TRANSCRIPT_BUDGET_CHARS = 4_000;

// Output cap for the per-part summaries (max 8 bullet points).
export const SUMMARY_MAX_OUTPUT_TOKENS = 1_024;

export interface LlmLimits {
  contextTokens: number;
  maxOutputTokens: number;
}

function positiveInt(raw: string | undefined): number | null {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function getLlmLimits(): LlmLimits {
  const hosted = usingHostedOpenAI();
  return {
    contextTokens: positiveInt(process.env.LLM_CONTEXT_TOKENS) ?? (hosted ? 128_000 : 32_768),
    maxOutputTokens: positiveInt(process.env.LLM_MAX_OUTPUT_TOKENS) ?? (hosted ? 16_384 : 4_096),
  };
}

// Characters of transcript that fit in one call, given the length of everything else in
// the prompt (system prompt, instruction, wrapper text). May be negative for a
// misconfigured (too small) context.
export function transcriptBudgetChars(fixedPromptChars: number): number {
  const { contextTokens, maxOutputTokens } = getLlmLimits();
  const fixedTokens = Math.ceil(fixedPromptChars / CHARS_PER_TOKEN);
  return Math.floor((contextTokens - maxOutputTokens - fixedTokens) * CHARS_PER_TOKEN);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/ai/llm-limits.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/llm-limits.ts src/lib/ai/llm-limits.test.ts
git commit -m "feat(ai): configurable LLM context window and output cap

Co-Authored-By: Claude <noreply@anthropic.com> via Dash <dash@syv.ai>"
```

---

### Task 3: Transcript shaping helpers

**Files:**
- Create: `src/lib/ai/transcript-text.ts`
- Test: `src/lib/ai/transcript-text.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ai/transcript-text.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  formatTime,
  mergeSpeakerTurns,
  renderTurns,
  splitTurns,
  type Turn,
} from './transcript-text';
import type { TranscriptSegment } from '@/types';

const seg = (speaker: string, start: number, text: string): TranscriptSegment => ({
  speaker,
  start,
  end: start + 1,
  text,
});

describe('formatTime', () => {
  it('formats seconds as m:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(3600)).toBe('60:00');
  });
});

describe('mergeSpeakerTurns', () => {
  it('collapses consecutive segments from the same speaker, keeping the first start', () => {
    const turns = mergeSpeakerTurns([
      seg('Taler 1', 0, 'Hej'),
      seg('Taler 1', 4, 'og velkommen'),
      seg('Taler 2', 9, 'Tak'),
      seg('Taler 1', 12, 'Nu starter vi'),
    ]);
    expect(turns).toEqual([
      { speaker: 'Taler 1', start: 0, text: 'Hej og velkommen' },
      { speaker: 'Taler 2', start: 9, text: 'Tak' },
      { speaker: 'Taler 1', start: 12, text: 'Nu starter vi' },
    ]);
  });

  it('returns an empty list for no segments', () => {
    expect(mergeSpeakerTurns([])).toEqual([]);
  });
});

describe('renderTurns', () => {
  it('renders one line per turn with speaker and m:ss timestamp', () => {
    const turns: Turn[] = [
      { speaker: 'Taler 1', start: 65, text: 'Hej' },
      { speaker: 'Taler 2', start: 70, text: 'Tak' },
    ];
    expect(renderTurns(turns)).toBe('[Taler 1] (1:05): Hej\n[Taler 2] (1:10): Tak');
  });
});

describe('splitTurns', () => {
  const turn = (i: number, text: string): Turn => ({
    speaker: `Taler ${(i % 2) + 1}`,
    start: i * 10,
    text,
  });

  it('returns a single part when everything fits', () => {
    const parts = splitTurns([turn(0, 'kort'), turn(1, 'også kort')], 1000);
    expect(parts).toHaveLength(1);
    expect(parts[0].start).toBe(0);
    expect(parts[0].text).toBe(renderTurns([turn(0, 'kort'), turn(1, 'også kort')]));
  });

  it('returns no parts for no turns', () => {
    expect(splitTurns([], 1000)).toEqual([]);
  });

  it('splits at turn boundaries and keeps every part within the budget', () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(i, `ord${i} `.repeat(20).trim()));
    const budget = 300;
    const parts = splitTurns(turns, budget);

    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.text.length).toBeLessThanOrEqual(budget);
    // Whole turns only: rejoining the parts reproduces the full rendering exactly.
    expect(parts.map((p) => p.text).join('\n')).toBe(renderTurns(turns));
  });

  it('starts each part at the start time of its first turn', () => {
    const turns = Array.from({ length: 6 }, (_, i) => turn(i, 'x'.repeat(100)));
    const parts = splitTurns(turns, 250);
    expect(parts[0].start).toBe(0);
    for (const p of parts) {
      const first = /\((\d+):(\d{2})\)/.exec(p.text)!;
      expect(p.start).toBe(Number(first[1]) * 60 + Number(first[2]));
    }
  });

  it('splits a single over-long turn at whitespace, losing no words', () => {
    const words = Array.from({ length: 200 }, (_, i) => `ord${i}`);
    const long: Turn = { speaker: 'Taler 1', start: 30, text: words.join(' ') };
    const budget = 300;
    const parts = splitTurns([long], budget);

    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.text.length).toBeLessThanOrEqual(budget);
    // Each piece is its own rendered line. Strip the "[Taler 1] (0:30): " prefix from every
    // line and rejoin: the words are intact (independent of how pieces pack into parts).
    const prefix = '[Taler 1] (0:30): ';
    const rejoined = parts
      .flatMap((p) => p.text.split('\n'))
      .map((line) => line.slice(prefix.length))
      .join(' ');
    expect(rejoined).toBe(long.text);
  });

  it('hard-splits a turn that has no whitespace at all', () => {
    const long: Turn = { speaker: 'Taler 1', start: 0, text: 'x'.repeat(1000) };
    const budget = 300;
    const parts = splitTurns([long], budget);

    for (const p of parts) expect(p.text.length).toBeLessThanOrEqual(budget);
    const prefix = '[Taler 1] (0:00): ';
    const rejoined = parts
      .flatMap((p) => p.text.split('\n'))
      .map((line) => line.slice(prefix.length))
      .join('');
    expect(rejoined).toBe(long.text);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/ai/transcript-text.test.ts`
Expected: FAIL. Cannot find module `./transcript-text`.

- [ ] **Step 3: Implement**

Create `src/lib/ai/transcript-text.ts`:

```ts
import type { TranscriptSegment } from '@/types';

// Pure helpers that shape a transcript for an LLM prompt. STT emits short utterances, so
// a person speaking for a minute becomes many segments; repeating the speaker label and
// timestamp on each wastes a large share of the prompt. Turns collapse those.

export interface Turn {
  speaker: string;
  start: number; // seconds from the start of the recording
  text: string;
}

export interface TurnPart {
  text: string;  // rendered turns, at most the requested budget
  start: number; // start (seconds) of the first turn in this part
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Collapse consecutive segments from the same speaker into one turn (start of the first).
export function mergeSpeakerTurns(segments: TranscriptSegment[]): Turn[] {
  const turns: Turn[] = [];
  for (const s of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker) {
      last.text = `${last.text} ${s.text}`;
    } else {
      turns.push({ speaker: s.speaker, start: s.start, text: s.text });
    }
  }
  return turns;
}

function renderTurn(turn: Turn): string {
  return `[${turn.speaker}] (${formatTime(turn.start)}): ${turn.text}`;
}

export function renderTurns(turns: Turn[]): string {
  return turns.map(renderTurn).join('\n');
}

// Split one turn into pieces whose rendered line fits in `budgetChars`: at the last
// whitespace before the limit, or hard at the limit when there is none.
function splitLongTurn(turn: Turn, budgetChars: number): Turn[] {
  const room = Math.max(1, budgetChars - renderTurn({ ...turn, text: '' }).length);
  if (turn.text.length <= room) return [turn];

  const pieces: Turn[] = [];
  let rest = turn.text;
  while (rest.length > room) {
    let cut = rest.lastIndexOf(' ', room);
    if (cut <= 0) cut = room;
    pieces.push({ ...turn, text: rest.slice(0, cut) });
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push({ ...turn, text: rest });
  return pieces;
}

// Pack consecutive turns into parts that each render to at most `budgetChars`, splitting
// at turn boundaries. Every character of every turn lands in exactly one part, in order
// (only the whitespace at an in-turn split point is dropped).
export function splitTurns(turns: Turn[], budgetChars: number): TurnPart[] {
  const parts: TurnPart[] = [];
  let lines: string[] = [];
  let size = 0;
  let partStart = 0;

  const flush = () => {
    if (lines.length > 0) {
      parts.push({ text: lines.join('\n'), start: partStart });
      lines = [];
      size = 0;
    }
  };

  for (const turn of turns) {
    for (const piece of splitLongTurn(turn, budgetChars)) {
      const line = renderTurn(piece);
      if (lines.length > 0 && size + 1 + line.length > budgetChars) flush();
      if (lines.length === 0) partStart = piece.start;
      size += (lines.length > 0 ? 1 : 0) + line.length;
      lines.push(line);
    }
  }
  flush();
  return parts;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/ai/transcript-text.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/transcript-text.ts src/lib/ai/transcript-text.test.ts
git commit -m "feat(ai): merge speaker turns and split transcripts to a budget

Co-Authored-By: Claude <noreply@anthropic.com> via Dash <dash@syv.ai>"
```

---

### Task 4: Bounded-concurrency map

**Files:**
- Create: `src/lib/ai/map-with-limit.ts`
- Test: `src/lib/ai/map-with-limit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ai/map-with-limit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapWithLimit } from './map-with-limit';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapWithLimit', () => {
  it('returns results in input order', async () => {
    const out = await mapWithLimit([3, 1, 2], 2, async (n) => {
      await sleep(n * 3);
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('never runs more than `limit` tasks at once, and does run them in parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithLimit(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it('handles an empty list', async () => {
    expect(await mapWithLimit([], 3, async (x) => x)).toEqual([]);
  });

  it('rejects with the first error and starts no new tasks afterwards', async () => {
    const started: number[] = [];
    await expect(
      mapWithLimit([0, 1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 1) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    await sleep(10);
    expect(started).toEqual([0, 1]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/ai/map-with-limit.test.ts`
Expected: FAIL. Cannot find module `./map-with-limit`.

- [ ] **Step 3: Implement**

Create `src/lib/ai/map-with-limit.ts`:

```ts
// Like Promise.all(items.map(fn)) but with at most `limit` calls in flight. Results keep
// input order. On the first failure it rejects and starts no further tasks. Small on
// purpose — not worth a dependency.
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/ai/map-with-limit.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/map-with-limit.ts src/lib/ai/map-with-limit.test.ts
git commit -m "feat(ai): bounded-concurrency map helper

Co-Authored-By: Claude <noreply@anthropic.com> via Dash <dash@syv.ai>"
```

---

### Task 5: Typed minutes errors

**Files:**
- Create: `src/lib/ai/minutes-errors.ts`

No separate test: the classes are exercised by Task 6 (thrown) and Task 7 (`instanceof` in the route). They live in their own module because `route.test.ts` replaces `@/lib/ai/minutes` with a mock that only exports `generateReferatBody`; importing the classes from there would make `instanceof` throw in that test.

- [ ] **Step 1: Create the module**

Create `src/lib/ai/minutes-errors.ts`:

```ts
// Errors the minutes generator throws instead of returning a truncated or partial referat.
// Kept apart from minutes.ts so the route (and its tests, which mock minutes.ts) can use
// `instanceof` without depending on the generator module.

/** The configured context window leaves too little room for a transcript. Operator problem. */
export class MinutesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MinutesConfigError';
  }
}

/** A call ended with finish_reason "length": the model ran out of output tokens. */
export class MinutesTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MinutesTruncatedError';
  }
}

/** Even after repeated summarising, the text does not fit the context budget. */
export class MinutesTooLongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MinutesTooLongError';
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai/minutes-errors.ts
git commit -m "feat(ai): typed errors for minutes generation limits

Co-Authored-By: Claude <noreply@anthropic.com> via Dash <dash@syv.ai>"
```

---

### Task 6: Budgeted generation flow

**Files:**
- Modify: `src/lib/ai/minutes.ts`
- Test: `src/lib/ai/minutes.test.ts`

This is the core change. Write all new tests first, watch them fail, then replace the generation half of `minutes.ts` (everything from the `// ─── Generation` comment down; `buildSkabelonInstruction` and the top constants stay).

- [ ] **Step 1: Write the failing tests**

In `src/lib/ai/minutes.test.ts`, change the first import line to also bring in `afterEach`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
```

Add these imports after the existing `import type { TranscriptSegment } from '@/types';` line:

```ts
import type { TranscriptChapter } from './chapters';
import {
  MinutesConfigError,
  MinutesTooLongError,
  MinutesTruncatedError,
} from './minutes-errors';
```

Append this block at the end of the file:

```ts
// ─── context budget ───────────────────────────────────────────────────────────

// Limits: 8000-token window, 1000 output tokens → a transcript budget of roughly 16k chars
// (the exact figure depends on the prompt's fixed text; tests assert invariants, not it).
describe('generateReferatBody — context budget', () => {
  const ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ENV,
      OPENAI_API_KEY: 'sk-test',
      LLM_CONTEXT_TOKENS: '8000',
      LLM_MAX_OUTPUT_TOKENS: '1000',
    };
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    mockComplete.mockReset();
  });

  afterEach(() => {
    process.env = ENV;
  });

  // Alternating speakers so nothing merges; every line carries a unique LINE-nnnn marker.
  function longTranscript(count: number, charsEach: number): TranscriptSegment[] {
    return Array.from({ length: count }, (_, i) => ({
      speaker: `Taler ${(i % 2) + 1}`,
      start: i * 10,
      end: i * 10 + 9,
      text: `LINE-${String(i).padStart(4, '0')} ${'x'.repeat(charsEach)}`,
    }));
  }

  const lastContent = (call: { messages: { content: string }[] }) =>
    call.messages[call.messages.length - 1].content;
  const isSummaryCall = (call: { messages: { content: string }[] }) =>
    lastContent(call).startsWith('Opsummer');

  function answerSummariesAndReferat() {
    mockComplete.mockImplementation(async (req: { messages: { content: string }[] }) =>
      openaiResponse(isSummaryCall(req) ? '- punkt' : 'REFERAT'),
    );
  }

  it('makes one call with max_tokens when the transcript fits', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('referat'));

    await generateReferatBody(sampleSegments, baseSpec);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockComplete.mock.calls[0][0].max_tokens).toBe(1000);
  });

  it('merges consecutive same-speaker segments into one turn', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('referat'));

    await generateReferatBody(
      [
        { speaker: 'Taler 1', start: 0, end: 2, text: 'Hej' },
        { speaker: 'Taler 1', start: 3, end: 5, text: 'og velkommen' },
        { speaker: 'Taler 2', start: 6, end: 8, text: 'Tak' },
      ],
      baseSpec,
    );

    const userContent = lastContent(mockComplete.mock.calls[0][0]);
    expect(userContent).toContain('[Taler 1] (0:00): Hej og velkommen');
    expect(userContent.match(/\[Taler 1\]/g)).toHaveLength(1);
  });

  it('summarises in parts when the transcript is over budget and there are no chapters', async () => {
    answerSummariesAndReferat();
    const count = 40;

    const result = await generateReferatBody(longTranscript(count, 1000), baseSpec);

    expect(result.body).toBe('REFERAT');
    const calls = mockComplete.mock.calls.map((c) => c[0]);
    const summaryCalls = calls.filter(isSummaryCall);
    expect(summaryCalls.length).toBeGreaterThanOrEqual(3);

    // The referat itself is written last, from summaries only (not raw transcript lines).
    expect(isSummaryCall(calls[calls.length - 1])).toBe(false);
    expect(lastContent(calls[calls.length - 1])).not.toContain('LINE-0000');

    // Budget invariant: no prompt exceeds (context - its own output cap) × 2.5 chars/token.
    for (const c of calls) {
      const promptChars = c.messages.reduce(
        (n: number, m: { content: string }) => n + m.content.length,
        0,
      );
      expect(promptChars).toBeLessThanOrEqual((8000 - c.max_tokens) * 2.5);
    }

    // No content dropped: every transcript line reaches exactly one summary call.
    for (let i = 0; i < count; i++) {
      const marker = `LINE-${String(i).padStart(4, '0')}`;
      expect(summaryCalls.filter((c) => lastContent(c).includes(marker))).toHaveLength(1);
    }
  });

  it('caps summary calls at 1024 output tokens', async () => {
    answerSummariesAndReferat();

    await generateReferatBody(longTranscript(40, 1000), baseSpec);

    const summaryCalls = mockComplete.mock.calls.map((c) => c[0]).filter(isSummaryCall);
    expect(summaryCalls.length).toBeGreaterThan(0); // guard against a vacuous pass
    for (const c of summaryCalls) expect(c.max_tokens).toBe(1024);
  });

  it('runs at most 3 summary calls at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    mockComplete.mockImplementation(async (req: { messages: { content: string }[] }) => {
      if (!isSummaryCall(req)) return openaiResponse('REFERAT');
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return openaiResponse('- punkt');
    });

    await generateReferatBody(longTranscript(100, 1000), baseSpec);

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('splits an oversized chapter into parts', async () => {
    answerSummariesAndReferat();
    const transcript = longTranscript(40, 1000);
    const chapters: TranscriptChapter[] = [
      {
        id: 'ch-0',
        title: 'Stort kapitel',
        summary: '',
        startTime: 0,
        endTime: 390,
        segmentIndices: Array.from({ length: 40 }, (_, i) => i),
      },
      { id: 'ch-1', title: 'Andet', summary: '', startTime: 400, endTime: 410, segmentIndices: [] },
    ];

    await generateReferatBody(transcript, baseSpec, undefined, chapters);

    const summaryCalls = mockComplete.mock.calls.map((c) => c[0]).filter(isSummaryCall);
    expect(summaryCalls.length).toBeGreaterThanOrEqual(3);
    expect(lastContent(summaryCalls[0])).toContain('"Stort kapitel (del 1/');
  });

  it('keeps the per-chapter path for chaptered transcripts over the 20k-character threshold', async () => {
    delete process.env.LLM_CONTEXT_TOKENS; // hosted defaults: 128k window, plenty of budget
    delete process.env.LLM_MAX_OUTPUT_TOKENS;
    answerSummariesAndReferat();
    const transcript = longTranscript(30, 1000); // ~31k chars, over 20k
    const chapters: TranscriptChapter[] = [
      {
        id: 'ch-0', title: 'Kapitel A', summary: '', startTime: 0, endTime: 140,
        segmentIndices: Array.from({ length: 15 }, (_, i) => i),
      },
      {
        id: 'ch-1', title: 'Kapitel B', summary: '', startTime: 150, endTime: 290,
        segmentIndices: Array.from({ length: 15 }, (_, i) => i + 15),
      },
    ];

    await generateReferatBody(transcript, baseSpec, undefined, chapters);

    const calls = mockComplete.mock.calls.map((c) => c[0]);
    expect(calls.filter(isSummaryCall)).toHaveLength(2);
    expect(lastContent(calls[0])).toContain('"Kapitel A"');
    expect(lastContent(calls[1])).toContain('"Kapitel B"');
    expect(isSummaryCall(calls[2])).toBe(false);
  });

  it('throws MinutesTruncatedError when the model hits its output limit', async () => {
    mockComplete.mockResolvedValueOnce({
      choices: [{ message: { content: 'halvt referat' }, finish_reason: 'length' }],
    });

    await expect(generateReferatBody(sampleSegments, baseSpec)).rejects.toBeInstanceOf(
      MinutesTruncatedError,
    );
  });

  it('throws MinutesConfigError when the context window is too small to be usable', async () => {
    process.env.LLM_CONTEXT_TOKENS = '1500';

    await expect(generateReferatBody(sampleSegments, baseSpec)).rejects.toBeInstanceOf(
      MinutesConfigError,
    );
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('throws MinutesTooLongError when summaries never shrink below the budget', async () => {
    mockComplete.mockImplementation(async () => openaiResponse('y'.repeat(20_000)));

    await expect(generateReferatBody(longTranscript(40, 1000), baseSpec)).rejects.toBeInstanceOf(
      MinutesTooLongError,
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/ai/minutes.test.ts`
Expected: the pre-existing tests still pass; the new "context budget" tests FAIL (no `max_tokens`, no splitting, no typed errors).

- [ ] **Step 3: Rewrite the generation half of `minutes.ts`**

Replace the import block at the top of `src/lib/ai/minutes.ts` (the first three lines) with:

```ts
import { TranscriptSegment } from '@/types';
import { TranscriptChapter } from '@/lib/ai/chapters';
import { getLlmClient, llmModel } from './llm-client';
import {
  getLlmLimits,
  transcriptBudgetChars,
  MIN_TRANSCRIPT_BUDGET_CHARS,
  SUMMARY_MAX_OUTPUT_TOKENS,
} from './llm-limits';
import { mapWithLimit } from './map-with-limit';
import { MinutesConfigError, MinutesTooLongError, MinutesTruncatedError } from './minutes-errors';
import { formatTime, mergeSpeakerTurns, renderTurns, splitTurns, type Turn } from './transcript-text';
```

Below the existing `CHAPTER_SPLIT_THRESHOLD` constant, add:

```ts
// At most this many summarise passes (the first counts as pass 1) before giving up.
const MAX_SUMMARY_ROUNDS = 3;

// Concurrent summary calls. The bundled vLLM runs with --max-num-seqs 4.
const SUMMARY_CONCURRENCY = 3;
```

Then delete everything from the line `// ─── Generation ───...` to the end of the file and replace it with:

```ts
// ─── Generation ───────────────────────────────────────────────────────────────

// The user message for the referat call. Also used with an empty transcript to measure
// the fixed part of the prompt, so keep the transcript last.
function buildBodyPrompt(transcriptText: string, instruction: string): string {
  return `Udarbejd et mødereferat baseret på denne transskription.
${instruction ? `\n${instruction}\n` : ''}
Følg instruktionerne ovenfor nøje — herunder ønsket længde og hvilke afsnit der skal med. Skriv referatet som ét sammenhængende dokument i markdown. Brug overskrifter (##) til afsnit og punktlister hvor det er relevant. Returner KUN selve referatet — ingen forklaringer, ingen JSON og ingen code blocks.

Transskription:
${transcriptText}`;
}

// A call that stops because it ran out of output tokens returns a cut-off document with no
// error. Never hand that to the user as if it were complete.
function assertNotTruncated(finishReason: string | null | undefined, what: string): void {
  if (finishReason === 'length') {
    throw new MinutesTruncatedError(`The model hit its output limit while writing the ${what}`);
  }
}

async function _generateBody(transcriptText: string, instruction: string): Promise<string> {
  const { maxOutputTokens } = getLlmLimits();
  const response = await getLlmClient().chat.completions.create({
    model: llmModel('gpt-4o'),
    max_tokens: maxOutputTokens,
    messages: [
      { role: 'system', content: MINUTES_SYSTEM_PROMPT },
      { role: 'user', content: buildBodyPrompt(transcriptText, instruction) },
    ],
  });

  assertNotTruncated(response.choices[0]?.finish_reason, 'referat');
  const raw = response.choices[0]?.message?.content ?? '';
  // Strip an accidental markdown code fence if the model wraps the document.
  return raw
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

async function _summarizePart(text: string, title: string): Promise<string> {
  const response = await getLlmClient().chat.completions.create({
    model: llmModel('gpt-4o'),
    max_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
    messages: [
      {
        role: 'user',
        content: `Opsummer mødeafsnittet "${title}" i korte punkter på dansk (max 8 punkter). Fokus på beslutninger, aftaler og vigtige diskussionspunkter.

${text}

Returner kun en punktliste.`,
      },
    ],
  });

  assertNotTruncated(response.choices[0]?.finish_reason, 'opsummering');
  return response.choices[0]?.message?.content?.trim() ?? '';
}

// A stretch of the meeting to summarise: a chapter, or the whole transcript.
interface Unit {
  title: string;
  turns: Turn[];
}

// Summarise every unit, splitting any unit larger than `budget` into parts. Returns one
// markdown section per part, in meeting order.
async function _summarizeUnits(units: Unit[], budget: number): Promise<string> {
  const jobs = units.flatMap((unit) => {
    const parts = splitTurns(unit.turns, budget);
    return parts.map((part, i) => ({
      heading:
        parts.length > 1
          ? `${unit.title} (del ${i + 1}/${parts.length}, fra ${formatTime(part.start)})`
          : unit.title,
      text: part.text,
    }));
  });

  const summaries = await mapWithLimit(jobs, SUMMARY_CONCURRENCY, (job) =>
    _summarizePart(job.text, job.heading),
  );
  return jobs.map((job, i) => `## ${job.heading}\n${summaries[i]}`).join('\n\n');
}

/**
 * Generate a referat as a single markdown document, driven by a Skabelon.
 *
 * The transcript is merged into speaker turns and measured against a character budget
 * derived from the model's context window (LLM_CONTEXT_TOKENS / LLM_MAX_OUTPUT_TOKENS).
 * If it fits, one call writes the referat. Otherwise the transcript is summarised in
 * parts and the referat is written from those summaries, so a long meeting never
 * overflows the window or comes back cut off.
 */
export async function generateReferatBody(
  transcript: TranscriptSegment[],
  spec: SkabelonSpec,
  participants?: string[],
  chapters?: TranscriptChapter[],
  customPrompt?: string,
): Promise<{ body: string }> {
  const t0 = Date.now();
  const instruction = buildSkabelonInstruction(spec, participants, customPrompt);

  const fixedChars = MINUTES_SYSTEM_PROMPT.length + buildBodyPrompt('', instruction).length;
  const budget = transcriptBudgetChars(fixedChars);
  if (budget < MIN_TRANSCRIPT_BUDGET_CHARS) {
    const { contextTokens, maxOutputTokens } = getLlmLimits();
    throw new MinutesConfigError(
      `LLM_CONTEXT_TOKENS=${contextTokens} leaves ${Math.max(budget, 0)} characters for the ` +
        `transcript after reserving ${maxOutputTokens} output tokens ` +
        `(minimum ${MIN_TRANSCRIPT_BUDGET_CHARS}). Raise LLM_CONTEXT_TOKENS or lower LLM_MAX_OUTPUT_TOKENS.`,
    );
  }

  const turns = mergeSpeakerTurns(transcript);
  const transcriptText = renderTurns(turns);
  const chapterList = chapters && chapters.length > 1 ? chapters : null;
  const overQualityThreshold =
    chapterList !== null && transcriptText.length > CHAPTER_SPLIT_THRESHOLD;

  if (transcriptText.length <= budget && !overQualityThreshold) {
    const body = await _generateBody(transcriptText, instruction);
    console.log(
      `[minutes] chars=${transcriptText.length} budget=${budget} mode=single parts=1 rounds=0 ms=${Date.now() - t0}`,
    );
    return { body };
  }

  const units: Unit[] = chapterList
    ? chapterList.map((ch) => ({
        title: ch.title,
        turns: mergeSpeakerTurns(ch.segmentIndices.map((i) => transcript[i]).filter(Boolean)),
      }))
    : [{ title: 'Mødet', turns }];

  let rounds = 1;
  let condensed = await _summarizeUnits(units, budget);
  while (condensed.length > budget) {
    if (rounds >= MAX_SUMMARY_ROUNDS) {
      throw new MinutesTooLongError(
        `Still ${condensed.length} characters (budget ${budget}) after ${rounds} summarise rounds`,
      );
    }
    rounds++;
    condensed = await _summarizeUnits(
      [{ title: 'Opsummering', turns: [{ speaker: 'Resumé', start: 0, text: condensed }] }],
      budget,
    );
  }

  const body = await _generateBody(condensed, instruction);
  console.log(
    `[minutes] chars=${transcriptText.length} budget=${budget} mode=split units=${units.length} rounds=${rounds} ms=${Date.now() - t0}`,
  );
  return { body };
}
```

The old private `formatTime` at the bottom of the file is deleted with the rest (it now comes from `transcript-text`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/ai/minutes.test.ts`
Expected: PASS: the pre-existing tests and all new ones. The pre-existing "includes formatted timestamps" test still passes because a single 65 s segment renders `(1:05)`.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no output. If `max_tokens` is reported as an unknown property, the installed `openai` types are older than expected; check `node_modules/openai/resources/chat/completions.d.ts` for `max_tokens` before changing anything.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/minutes.ts src/lib/ai/minutes.test.ts
git commit -m "fix(ai): size the minutes prompt against the model context window

Merge same-speaker turns, derive a transcript budget from
LLM_CONTEXT_TOKENS / LLM_MAX_OUTPUT_TOKENS, summarise over-long
transcripts in parts (3 at a time), cap output with max_tokens and treat
finish_reason=length as an error instead of returning a cut-off referat.

Co-Authored-By: Claude <noreply@anthropic.com> via Dash <dash@syv.ai>"
```

---

### Task 7: Route error mapping

**Files:**
- Modify: `src/app/api/minutes/route.ts` (imports; the `generateReferatBody` call near line 67)
- Test: `src/app/api/minutes/route.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/app/api/minutes/route.test.ts`, add this import after the existing `import { FAKE_SESSION, makeJsonReq } from '@/test/helpers';` line:

```ts
import {
  MinutesConfigError,
  MinutesTooLongError,
  MinutesTruncatedError,
} from '@/lib/ai/minutes-errors';
```

Add these tests inside the existing `describe('POST /api/minutes', ...)`, directly after the test named `'returns JSON 500 with parseable body when generateReferatBody throws'` (it ends with its closing `});`):

```ts
  it('maps MinutesTooLongError to a 422 with a Danish message', async () => {
    mockGenerateReferatBody.mockRejectedValueOnce(new MinutesTooLongError('still too long'));

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('for langt');
  });

  it('maps MinutesTruncatedError to a 422 with a Danish message', async () => {
    mockGenerateReferatBody.mockRejectedValueOnce(new MinutesTruncatedError('hit output limit'));

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('svargrænse');
  });

  it('maps MinutesConfigError to a 500 with a Danish message', async () => {
    mockGenerateReferatBody.mockRejectedValueOnce(new MinutesConfigError('window too small'));

    const res = await POST(makeJsonReq(BASE_URL, 'POST', { segments: sampleSegments }));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('indstillinger');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/app/api/minutes/route.test.ts`
Expected: the three new tests FAIL (all return the generic `Internal server error` 500; the two 422 tests get 500).

- [ ] **Step 3: Implement**

In `src/app/api/minutes/route.ts`, add to the imports:

```ts
import {
  MinutesConfigError,
  MinutesTooLongError,
  MinutesTruncatedError,
} from '@/lib/ai/minutes-errors';
```

Replace the existing call

```ts
  const content = await generateReferatBody(
    segments,
    spec,
    participants,
    chapters,
    customPrompt,
  );
```

with:

```ts
  let content;
  try {
    content = await generateReferatBody(segments, spec, participants, chapters, customPrompt);
  } catch (err) {
    // Known limits get a message the UI shows as-is (it displays `data.error`); the
    // details go to the server log. Anything else falls through to withHandler's generic 500.
    if (err instanceof MinutesTooLongError) {
      console.error('[minutes]', err);
      return NextResponse.json(
        { error: 'Mødet er for langt til at blive opsummeret med den nuværende AI-model. Kontakt administratoren.' },
        { status: 422 },
      );
    }
    if (err instanceof MinutesTruncatedError) {
      console.error('[minutes]', err);
      return NextResponse.json(
        { error: 'Referatet blev ikke færdigt, fordi AI-modellens svargrænse blev nået. Prøv igen med en kortere skabelon, eller kontakt administratoren.' },
        { status: 422 },
      );
    }
    if (err instanceof MinutesConfigError) {
      console.error('[minutes]', err);
      return NextResponse.json(
        { error: 'AI-modellens indstillinger tillader ikke at generere et referat. Kontakt administratoren.' },
        { status: 500 },
      );
    }
    throw err;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/api/minutes/route.test.ts`
Expected: PASS (existing tests and the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/minutes/route.ts src/app/api/minutes/route.test.ts
git commit -m "fix(minutes): show a clear Danish error when a referat exceeds the model limits

Co-Authored-By: Claude <noreply@anthropic.com> via Dash <dash@syv.ai>"
```

---

### Task 8: Compose wiring and documentation

**Files:**
- Modify: `docker-compose.yml` (app `environment`, after the `LLM_MODEL` line, ~line 85)
- Modify: `.env.example` (after `LLM_MODEL=`, ~line 16)
- Modify: `.env.deploy.example` (after `LLM_MODEL=…`, ~line 42)
- Modify: `DEPLOY.md` (new section before `## Day-2 operations`)

Compose passes env through an explicit allow-list, so a setting that is not listed here has no effect in a Docker deployment (this is exactly what #84 and #85 were about).

- [ ] **Step 1: `docker-compose.yml`**

Replace

```yaml
      - LLM_BASE_URL=${LLM_BASE_URL:-}
      - LLM_MODEL=${LLM_MODEL:-}
```

with:

```yaml
      - LLM_BASE_URL=${LLM_BASE_URL:-}
      - LLM_MODEL=${LLM_MODEL:-}
      # Context window and output cap of the chat model; minutes generation sizes its
      # prompt from them. LLM_CONTEXT_TOKENS falls back to VLLM_CHAT_MAX_MODEL_LEN so one
      # number configures both vLLM and the app; empty → the app's own default.
      - LLM_CONTEXT_TOKENS=${LLM_CONTEXT_TOKENS:-${VLLM_CHAT_MAX_MODEL_LEN:-}}
      - LLM_MAX_OUTPUT_TOKENS=${LLM_MAX_OUTPUT_TOKENS:-}
```

- [ ] **Step 2: `.env.example`**

Replace the line `LLM_MODEL=` (the one directly after `LLM_BASE_URL=`) with:

```
LLM_MODEL=
# Context window (tokens) and output cap of the chat model. Minutes generation sizes its
# prompt from these and summarises long meetings in parts instead of overflowing.
# Blank = defaults: 128000 / 16384 for hosted OpenAI, 32768 / 4096 for anything else.
# Set LLM_CONTEXT_TOKENS to your model's real window if you use LLM_BASE_URL or self-host.
LLM_CONTEXT_TOKENS=
LLM_MAX_OUTPUT_TOKENS=
```

- [ ] **Step 3: `.env.deploy.example`**

Replace the line `LLM_MODEL=google/gemma-4-12b-it` with:

```
LLM_MODEL=google/gemma-4-12b-it
# Context window and output cap of the chat model (see DEPLOY.md → "Long meetings: LLM
# context window"). LLM_CONTEXT_TOKENS follows VLLM_CHAT_MAX_MODEL_LEN (the vLLM setting,
# default 32768) when left blank, so normally you set neither here.
LLM_CONTEXT_TOKENS=
LLM_MAX_OUTPUT_TOKENS=
```

- [ ] **Step 4: `DEPLOY.md`**

Insert this section directly before the `## Day-2 operations` heading:

```markdown
## Long meetings: LLM context window

Minutes generation sizes its prompt from the chat model's context window. A transcript
that fits goes to the model in one call; a longer one is summarised in parts and the
referat is written from the summaries, so a long meeting never overflows the window or
comes back cut off. If even that is not possible the user sees a clear error instead of
an incomplete referat.

| Variable | Default | Meaning |
|---|---|---|
| `LLM_CONTEXT_TOKENS` | `128000` for hosted OpenAI, `32768` otherwise | The model's context window in tokens |
| `LLM_MAX_OUTPUT_TOKENS` | `16384` for hosted OpenAI, `4096` otherwise | Longest referat the model may write |

With the bundled vLLM, `LLM_CONTEXT_TOKENS` follows `VLLM_CHAT_MAX_MODEL_LEN` automatically,
so changing the vLLM window changes the app too. If you point `LLM_BASE_URL` at your own
model, set `LLM_CONTEXT_TOKENS` to that model's real window; the default is deliberately
conservative because the app cannot know it. Both are read at runtime: change them and run
`docker compose up -d app`, no rebuild.
```

- [ ] **Step 5: Verify the compose wiring**

Run:

```bash
echo "unset:";            docker compose config 2>/dev/null | grep -E "LLM_(CONTEXT|MAX_OUTPUT)_TOKENS"
echo "explicit:";         LLM_CONTEXT_TOKENS=8000 LLM_MAX_OUTPUT_TOKENS=1000 docker compose config 2>/dev/null | grep -E "LLM_(CONTEXT|MAX_OUTPUT)_TOKENS"
echo "from vLLM value:";  VLLM_CHAT_MAX_MODEL_LEN=16384 docker compose config 2>/dev/null | grep -E "LLM_CONTEXT_TOKENS"
echo "explicit wins:";    LLM_CONTEXT_TOKENS=8000 VLLM_CHAT_MAX_MODEL_LEN=16384 docker compose config 2>/dev/null | grep -E "LLM_CONTEXT_TOKENS"
```

Expected:
- unset: both lines are `""`
- explicit: `"8000"` and `"1000"`
- from vLLM value: `LLM_CONTEXT_TOKENS: "16384"`
- explicit wins: `LLM_CONTEXT_TOKENS: "8000"`

(A `.env` in the repo root is read by compose too. If yours sets either variable, the "unset" case will show that value; that is expected.)

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example .env.deploy.example DEPLOY.md
git commit -m "feat(deploy): pass LLM context window and output cap through compose

Co-Authored-By: Claude <noreply@anthropic.com> via Dash <dash@syv.ai>"
```

---

### Task 9: Full checks

- [ ] **Step 1: Type-check**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 2: Lint**

The repo has no ESLint configuration, so `npm run lint` (`next lint`) is interactive and offers to create one. Do **not** accept: press Ctrl+C / answer Cancel, and confirm `git status` shows no new files. Lint is not part of CI here; rely on `tsc` and the tests.

- [ ] **Step 3: Whole test suite**

Run: `npm test`
Expected: all test files pass (before this work: 93 files, 1901 tests; expect more now).

- [ ] **Step 4: If anything fails**

Read the failure, fix the cause in the relevant task's files, re-run that file, then re-run `npm test`. Do not weaken or delete an existing test to make it pass.

---

### Task 10: Real-model end-to-end check (not committed)

Unit tests mock the model. This runs the split path against real OpenAI with an artificially small window, to confirm the referat actually covers every part of a long meeting.

**Files:**
- Create then delete: `src/lib/ai/zz-real-minutes.test.ts` (never committed)

- [ ] **Step 1: Write the temporary check**

Create `src/lib/ai/zz-real-minutes.test.ts`:

```ts
import { appendFileSync } from 'node:fs';
import { it } from 'vitest';
import { generateReferatBody } from './minutes';
import type { TranscriptSegment } from '@/types';

const OUT = process.env.CHECK_OUT!;

// 12 agenda items, each with one distinctive fact that must survive summarising.
const FACTS = [
  'budgettet for vejvedligehold hæves med 2,4 millioner kroner',
  'skolen i Rønde får en ny idrætshal med åbning i august 2027',
  'kommunen ansætter tre nye sagsbehandlere på børneområdet',
  'parkeringsafgiften i havnen stiger til 18 kroner i timen',
  'biblioteket holder åbent til klokken 20 om torsdagen',
  'der afsættes 850.000 kroner til nye legepladser',
  'affaldsgebyret sænkes med 6 procent fra 1. januar',
  'plejehjemmet i Ebeltoft udvides med fjorten boliger',
  'cykelstien langs kystvejen forlænges med 3,2 kilometer',
  'kommunens hjemmeside får ny digital selvbetjening',
  'sommerferielukningen af daginstitutioner reduceres til to uger',
  'lokalplanen for det nye erhvervsområde sendes i høring',
];

it('real model: long meeting covers every agenda item', async () => {
  const transcript: TranscriptSegment[] = [];
  let t = 0;
  FACTS.forEach((fact, i) => {
    for (let k = 0; k < 24; k++) {
      const speaker = `Taler ${(k % 3) + 1}`;
      const text =
        k === 10
          ? `Punkt ${i + 1}: Vi beslutter at ${fact}.`
          : `Vi drøfter punkt ${i + 1} og de økonomiske og praktiske konsekvenser for borgerne, ` +
            `herunder høringssvar, tidsplan og ansvar, som vi tidligere har gennemgået i udvalget (bemærkning ${k}).`;
      transcript.push({ speaker, start: t, end: t + 8, text });
      t += 10;
    }
  });

  const t0 = Date.now();
  const { body } = await generateReferatBody(
    transcript,
    { prompt: 'Lav et kortfattet referat med alle beslutninger.', includeDeltagere: false, includeBeslutningspunkter: true, includeDagsorden: false, includeDato: false },
  );
  appendFileSync(OUT, `SECONDS ${Math.round((Date.now() - t0) / 1000)}\nCHARS_IN ${transcript.map((s) => s.text).join('\n').length}\nBODY\n${body}\n`);
}, 300_000);
```

- [ ] **Step 2: Run it with a deliberately small window**

Run (the key is read from `.env` and never printed):

```bash
OUT=/private/tmp/claude-501/-Users-nikolajmeineche-Desktop-worktrees-test-issues-3bf/d11c37c2-cd90-4f06-b213-fcea3a794905/scratchpad/real-minutes.txt
rm -f "$OUT"
CHECK_OUT="$OUT" \
OPENAI_API_KEY="$(grep -E '^OPENAI_API_KEY=' .env | cut -d= -f2-)" \
LLM_CONTEXT_TOKENS=6000 LLM_MAX_OUTPUT_TOKENS=1500 \
npx vitest run src/lib/ai/zz-real-minutes.test.ts 2>&1 | tail -5
```

Expected: 1 test passes. Vitest hides `console.log`, so to *prove* the split path was taken, spy on it (`vi.spyOn(console, 'log')`), collect lines starting with `[minutes]`, and write them to the result file: a real 128k-window model would also cope with the whole transcript in one call, so a good referat alone proves nothing. Expect `mode=split`.

- [ ] **Step 3: Check coverage of the referat**

Read `real-minutes.txt`. Count how many of the 12 facts appear in the referat (allow for paraphrase: "2,4 millioner" for the road budget, "tre nye sagsbehandlere", and so on). Record the count and the `SECONDS` figure. A model may legitimately drop a fact or two when compressing; if fewer than ~9 of 12 survive, or the referat ends mid-sentence, investigate before continuing: check the `[minutes] … mode=split` log line and whether `finish_reason` was ever `length`.

- [ ] **Step 4: Delete the temporary test**

```bash
rm -f src/lib/ai/zz-real-minutes.test.ts
git status --short
```

Expected: `git status` shows nothing to commit.

---

### Task 11: Open the PR

- [ ] **Step 1: Confirm the branch is clean and up to date**

```bash
git status --short          # expect no output
git fetch -q origin main
git log --oneline origin/main..HEAD
```

Expected: the spec, plan and task commits only. If `origin/main` has moved (for example #108 merged), run `git rebase origin/main`. Expect one conflict in `docker-compose.yml`, `.env.example`, `.env.deploy.example` and `DEPLOY.md`: keep **both** sides (the diarization-timeout lines/section from #108 and the LLM lines/section from this branch), then `git rebase --continue` and re-run `npm test`.

- [ ] **Step 2: Write the PR description to a file**

Write it to `$SCRATCH/pr-body.md` (the session scratchpad directory, not the repo). It must contain, in this order, with the real numbers from Tasks 9 and 10 filled in:

1. **Problem:** silent truncation (no `max_tokens`, `finish_reason` ignored); every referat is one whole-transcript call because the UI never sends `chapters`; speaker-label overhead; overflow reaches the user as a generic "Internal server error".
2. **Change:** the two settings and their defaults; the budget formula; turn merging; splitting with 3-way concurrency; `max_tokens`; typed errors and their Danish messages; compose wiring and docs.
3. **How this was tested:** unit tests (list the areas), the result of the real-model run from Task 10 (window used, facts found out of 12, duration), `docker compose config` results.
4. **Limits:** a self-hosted vLLM with a small window was not run; 2.5 chars/token is a pessimistic estimate, not a measurement of the production model.
5. **Follow-ups:** `chapters.ts` and `pii.ts` still send unchunked transcripts; the UI does not send `chapters`; the route's `maxDuration`.
6. `Fixes #97`, and credit to the approach described in #97.
7. As the last line: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

- [ ] **Step 3: Push and open the PR**

Ask the user before this step: pushing and opening a PR is outward-facing.

```bash
git push -u origin feat/minutes-context-budget
gh pr create --base main --head feat/minutes-context-budget \
  --title "fix(ai): size minutes prompt against the model context window" \
  --body-file "$SCRATCH/pr-body.md"
```

- [ ] **Step 4: Check the PR**

```bash
sleep 20
gh pr view --json state,mergeable,statusCheckRollup -q '"state: \(.state), mergeable: \(.mergeable)", (.statusCheckRollup[]? | "check: \(.name // .context) -> \(.conclusion // .status)")'
```

Expected: `OPEN`, `MERGEABLE`, and the `Validate PR title` check succeeding.

- [ ] **Step 5: Tell the reporter**

Comment on #97 linking the PR (one or two sentences), as promised in the earlier comment.

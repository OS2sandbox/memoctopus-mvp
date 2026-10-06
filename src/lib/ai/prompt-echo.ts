// Best-effort confidentiality helpers for LOCKED CENTRAL template prompts.
//
// These raise the bar, they do not make a leak impossible: the transcript itself
// cannot be sanitised, paraphrased leaks are not detected and short prompts are
// not checked. Nothing in here ever logs or returns the prompt text itself.

// ─── Sanitising client-controlled strings that end up in the instruction ─────

export const MAX_PARTICIPANTS = 100;
export const MAX_PARTICIPANT_CHARS = 80;
export const MAX_CHAPTERS = 200;
export const MAX_CHAPTER_FIELD_CHARS = 120;

/**
 * One line of plain text: control characters and line/paragraph separators become
 * spaces, whitespace is collapsed, the result is trimmed and cut at `maxChars`.
 * Non-strings yield ''.
 */
export function sanitizeForInstruction(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const flat = value
    // C0/C1 controls (incl. \n \r \t), DEL, line/paragraph separators, BOM and
    // zero-width / bidi formatting characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= maxChars) return flat;
  return flat.slice(0, maxChars).trim();
}

/** At most MAX_PARTICIPANTS non-empty single-line names of at most MAX_PARTICIPANT_CHARS. */
export function sanitizeParticipants(participants: unknown): string[] {
  if (!Array.isArray(participants)) return [];
  const out: string[] = [];
  for (const p of participants) {
    const clean = sanitizeForInstruction(p, MAX_PARTICIPANT_CHARS);
    if (clean) out.push(clean);
    if (out.length >= MAX_PARTICIPANTS) break;
  }
  return out;
}

interface ChapterLike {
  title: string;
  summary: string;
  segmentIndices: number[];
}

/**
 * Caps the count and flattens the free-text fields (title, summary) of
 * client-supplied chapters. `segmentIndices` are kept only as non-negative
 * integers, so they stay indices and cannot carry text.
 */
export function sanitizeChapters<T extends ChapterLike>(chapters: T[] | undefined): T[] | undefined {
  if (!Array.isArray(chapters)) return undefined;
  return chapters.slice(0, MAX_CHAPTERS).map((ch) => ({
    ...ch,
    title: sanitizeForInstruction(ch?.title, MAX_CHAPTER_FIELD_CHARS),
    summary: sanitizeForInstruction(ch?.summary, MAX_CHAPTER_FIELD_CHARS),
    segmentIndices: Array.isArray(ch?.segmentIndices)
      ? ch.segmentIndices.filter((i) => Number.isInteger(i) && i >= 0)
      : [],
  }));
}

// ─── Output echo detection ────────────────────────────────────────────────────

export const ECHO_MIN_CHECKED_CHARS = 30;
export const ECHO_WINDOW_CHARS = 60;
export const ECHO_SHORT_PROMPT_BELOW = 75;
export const ECHO_PLACEHOLDER = '[udeladt]';

export interface EchoSpan {
  /** Inclusive start / exclusive end, as offsets into the ORIGINAL output text. */
  start: number;
  end: number;
}

interface Normalised {
  text: string;
  /** For each normalised char: offset of its source char / end offset of it in the original. */
  from: number[];
  to: number[];
}

/**
 * Lower-cases and keeps only letters and digits; every other run (whitespace,
 * markdown and punctuation noise) becomes a single space. Keeps an offset map so
 * matches can be reported in the original text.
 */
function normalise(input: string): Normalised {
  const chars: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let lastWasSpace = true; // drops leading noise
  let i = 0;
  for (const ch of input) {
    const start = i;
    i += ch.length;
    const lower = ch.toLowerCase();
    let any = false;
    for (const c of lower) {
      if (/[\p{L}\p{N}]/u.test(c)) {
        chars.push(c);
        from.push(start);
        to.push(i);
        lastWasSpace = false;
        any = true;
      }
    }
    if (!any && !lastWasSpace) {
      chars.push(' ');
      from.push(start);
      to.push(i);
      lastWasSpace = true;
    }
  }
  return { text: chars.join(''), from, to };
}

/** Window length for a prompt of `normalisedLength`, or 0 when it is not checked. */
function windowFor(normalisedLength: number): number {
  if (normalisedLength < ECHO_MIN_CHECKED_CHARS) return 0;
  if (normalisedLength < ECHO_SHORT_PROMPT_BELOW) {
    return Math.max(ECHO_MIN_CHECKED_CHARS, Math.floor(0.8 * normalisedLength));
  }
  return ECHO_WINDOW_CHARS;
}

/** Windows of a prompt, built once and reused over many output fields. */
export interface PromptEchoMatcher {
  windowSize: number;
  grams: Set<string>;
}

export function buildPromptEchoMatcher(prompt: string): PromptEchoMatcher | null {
  const p = normalise(prompt).text.trim();
  const w = windowFor(p.length);
  if (w === 0) return null;
  const grams = new Set<string>();
  for (let i = 0; i + w <= p.length; i++) grams.add(p.slice(i, i + w));
  return { windowSize: w, grams };
}

function detectWith(matcher: PromptEchoMatcher, output: string): EchoSpan[] {
  const n = normalise(output);
  const w = matcher.windowSize;
  if (n.text.length < w) return [];

  // Merge overlapping / adjacent matching windows into runs (normalised coords).
  const runs: Array<[number, number]> = [];
  for (let i = 0; i + w <= n.text.length; i++) {
    if (!matcher.grams.has(n.text.slice(i, i + w))) continue;
    const last = runs[runs.length - 1];
    if (last && i <= last[1]) last[1] = i + w;
    else runs.push([i, i + w]);
  }

  const spans: EchoSpan[] = [];
  for (let [s, e] of runs) {
    while (s < e && n.text[s] === ' ') s++;
    while (e > s && n.text[e - 1] === ' ') e--;
    if (e <= s) continue;
    spans.push({ start: n.from[s], end: n.to[e - 1] });
  }
  return spans;
}

/**
 * Finds verbatim runs of the prompt in `output` (case, whitespace, markdown and
 * punctuation insensitive): at least 60 normalised chars, or for prompts under
 * 75 chars max(30, floor(0.8 * length)). Prompts under 30 chars are not checked.
 * Returns spans in the original output text; O(n * window) on the output.
 */
export function detectPromptEcho(output: string, prompt: string): EchoSpan[] {
  const matcher = buildPromptEchoMatcher(prompt);
  return matcher ? detectWith(matcher, output) : [];
}

function redactWith(matcher: PromptEchoMatcher, text: string): { text: string; redacted: boolean } {
  const spans = detectWith(matcher, text);
  if (spans.length === 0) return { text, redacted: false };
  let out = '';
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue;
    out += text.slice(pos, s.start) + ECHO_PLACEHOLDER;
    pos = s.end;
  }
  return { text: out + text.slice(pos), redacted: true };
}

export function redactPromptEcho(output: string, prompt: string): { text: string; redacted: boolean } {
  const matcher = buildPromptEchoMatcher(prompt);
  return matcher ? redactWith(matcher, output) : { text: output, redacted: false };
}

/**
 * Walks every string in a structured value (arrays and plain objects, e.g. a
 * MinutesContent) and redacts echoed prompt spans. Returns a new value; the input
 * is not mutated. `redacted` is true when anything was replaced.
 */
export function redactPromptEchoDeep<T>(value: T, prompt: string): { value: T; redacted: boolean } {
  const matcher = buildPromptEchoMatcher(prompt);
  if (!matcher) return { value, redacted: false };
  let redacted = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactWith(matcher, v);
      if (r.redacted) redacted = true;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(value) as T, redacted };
}

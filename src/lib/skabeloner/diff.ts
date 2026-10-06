// Dependency-free line diff for the changelog view. Prompts are capped at 20000
// characters, but a pathological one (20000 one-character lines) would make a
// full LCS table enormous, so the table size is bounded and larger inputs fall
// back to "everything between the common head and tail changed".

export type DiffLineType = 'equal' | 'insert' | 'delete';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  /** True when the input was too large for an exact diff and the middle was replaced wholesale. */
  approximate: boolean;
}

/** Upper bound on LCS table cells (rows x columns) after trimming common head and tail. */
export const MAX_DIFF_CELLS = 1_000_000;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

export function diffLines(before: string, after: string, maxCells: number = MAX_DIFF_CELLS): DiffResult {
  const a = splitLines(before);
  const b = splitLines(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const lines: DiffLine[] = a.slice(0, head).map((text) => ({ type: 'equal', text }));
  let approximate = false;

  if (midA.length === 0 || midB.length === 0) {
    for (const text of midA) lines.push({ type: 'delete', text });
    for (const text of midB) lines.push({ type: 'insert', text });
  } else if ((midA.length + 1) * (midB.length + 1) > maxCells) {
    approximate = true;
    for (const text of midA) lines.push({ type: 'delete', text });
    for (const text of midB) lines.push({ type: 'insert', text });
  } else {
    lines.push(...lcsDiff(midA, midB));
  }

  for (const text of a.slice(a.length - tail)) lines.push({ type: 'equal', text });
  return { lines, approximate };
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // lcs[i][j] = length of the LCS of a[i..] and b[j..].
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'equal', text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      out.push({ type: 'delete', text: a[i++] });
    } else {
      out.push({ type: 'insert', text: b[j++] });
    }
  }
  while (i < n) out.push({ type: 'delete', text: a[i++] });
  while (j < m) out.push({ type: 'insert', text: b[j++] });
  return out;
}

export function hasChanges(result: DiffResult): boolean {
  return result.lines.some((l) => l.type !== 'equal');
}

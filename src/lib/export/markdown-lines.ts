// Line/inline classification for the PDF and docx exports. The export route's
// renderers have no markdown engine; this module turns the referat markdown
// (tiptap's serialization: `**strong**`, `*em*`, `` `code` ``, `-`/`*` bullets,
// `1.` ordered items, `#`..`######` headings) into typed lines whose text is a
// list of styled runs, so both renderers can carry the formatting through
// instead of stripping it.

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export type Line =
  | { kind: 'heading'; runs: InlineRun[] }
  | { kind: 'bullet'; runs: InlineRun[] }
  // `number` is the source's own numeral (what the user sees in the editor);
  // `group` ties consecutive items into one list so docx can restart numbering
  // per list instead of continuing 4, 5 … into the next one.
  | { kind: 'ordered'; runs: InlineRun[]; number: number; group: number }
  | { kind: 'text'; runs: InlineRun[] };

interface Style {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

// Earliest-match tokenizer. Alternation order matters: *** before ** before *,
// so bold+italic is not eaten as bold with stray asterisks. Non-greedy bodies
// that must not be empty, so unmatched/lone markers fall through as literal
// text — user characters are never swallowed.
const INLINE_TOKEN = /\*\*\*([^*]+?)\*\*\*|\*\*(.+?)\*\*|\*([^*]+?)\*|`([^`]+?)`/;

// The editor backslash-escapes literal markdown punctuation in text (`\*`, `` \` ``…).
// Those characters are data, not markers: hide each escape behind a private-use-area
// sentinel before tokenizing, and restore the bare character in the finished runs.
const ESCAPE = /\\([\\`*_{}[\]()#+\-.!>~])/g;
const SENTINEL = /(\d+)/g;

export function parseInline(text: string): InlineRun[] {
  const escaped: string[] = [];
  const shielded = text.replace(ESCAPE, (_, ch: string) => {
    escaped.push(ch);
    return `${escaped.length - 1}`;
  });
  const runs = parseStyled(shielded, {});
  if (escaped.length === 0) return runs;
  return runs.map((run) => ({
    ...run,
    text: run.text.replace(SENTINEL, (_, i: string) => escaped[Number(i)]),
  }));
}

function parseStyled(text: string, style: Style): InlineRun[] {
  const runs: InlineRun[] = [];
  let rest = text;
  for (;;) {
    const m = INLINE_TOKEN.exec(rest);
    if (!m) break;
    if (m.index > 0) runs.push(makeRun(rest.slice(0, m.index), style));
    const [, boldItalic, bold, italic, code] = m;
    if (boldItalic !== undefined) {
      runs.push(...parseStyled(boldItalic, { ...style, bold: true, italic: true }));
    } else if (bold !== undefined) {
      // Recurse so `**fed *og kursiv***`-style nesting keeps both marks.
      runs.push(...parseStyled(bold, { ...style, bold: true }));
    } else if (italic !== undefined) {
      runs.push(...parseStyled(italic, { ...style, italic: true }));
    } else if (code !== undefined) {
      // No markdown inside code spans.
      runs.push(makeRun(code, { ...style, code: true }));
    }
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest.length > 0) runs.push(makeRun(rest, style));
  return runs;
}

function makeRun(text: string, style: Style): InlineRun {
  const run: InlineRun = { text };
  if (style.bold) run.bold = true;
  if (style.italic) run.italic = true;
  if (style.code) run.code = true;
  return run;
}

export function runsToPlainText(runs: InlineRun[]): string {
  return runs.map((r) => r.text).join('');
}

export function parseLines(markdown: string): Line[] {
  const lines: Line[] = [];
  // Ordered-list grouping state: a new group starts when the previous rendered
  // line was not part of the same list — i.e. anything non-ordered in between,
  // or a numeral that restarts at 1 (two adjacent lists survive the blank-line
  // filter as consecutive ordered lines; the restart is what separates them).
  let group = -1;
  let prevNumber: number | null = null;

  for (const raw of markdown.split('\n')) {
    const l = raw.trimEnd();
    if (l.trim().length === 0) continue;

    const heading = l.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      lines.push({ kind: 'heading', runs: parseInline(heading[1].trim()) });
      prevNumber = null;
      continue;
    }
    const bullet = l.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      lines.push({ kind: 'bullet', runs: parseInline(bullet[1]) });
      prevNumber = null;
      continue;
    }
    const ordered = l.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ordered) {
      const number = Number(ordered[1]);
      if (prevNumber === null || number === 1) group++;
      lines.push({ kind: 'ordered', runs: parseInline(ordered[2]), number, group });
      prevNumber = number;
      continue;
    }
    lines.push({ kind: 'text', runs: parseInline(l) });
    prevNumber = null;
  }
  return lines;
}

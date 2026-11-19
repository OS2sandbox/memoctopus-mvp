import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { MinutesContent } from '@/types';
import { minutesToBody } from '@/lib/minutes-format';
import { withHandler } from '@/lib/api-handler';
import { parseLines, type InlineRun, type Line } from '@/lib/export/markdown-lines';

async function postHandler(req: NextRequest): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as { title?: string; content?: MinutesContent; format?: string };
  const { title = 'Referat', content, format = 'pdf' } = body;

  if (!content || (content.body == null && !content.sections && !content.header)) {
    return NextResponse.json({ error: 'Missing content' }, { status: 400 });
  }

  // Render the same editable document header the preview shows: the title always,
  // the date only when present (it's only set when the "Dato" tag was selected).
  const docTitle = content.header?.title?.trim() || title;
  const docDate = content.header?.date?.trim() || null;
  const markdown = normalizeMarkdown(minutesToBody(content));

  if (format === 'pdf') {
    return exportPdf(docTitle, docDate, markdown);
  } else if (format === 'docx') {
    return exportDocx(docTitle, docDate, markdown);
  } else if (format === 'md') {
    return exportMarkdown(docTitle, docDate, markdown);
  }

  return NextResponse.json({ error: 'Unknown format' }, { status: 400 });
}

export const POST = withHandler('export', postHandler);

// The rich-text editor serialises soft line breaks as CommonMark hard breaks — a
// trailing backslash before the newline (and a lone "\" for an empty break line).
// Left as-is those backslashes render literally in the export; strip the marker so
// the break renders as the blank line the user sees in the editor.
function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\\(\r?\n)/g, '$1');
}

function exportMarkdown(title: string, date: string | null, markdown: string): NextResponse {
  const lines = [
    `# ${title}`,
    ...(date ? ['', `*${date}*`] : []),
    '',
    markdown.trim() || '*(ingen indhold)*',
    '',
  ];
  return new NextResponse(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="referat.md"`,
    },
  });
}

// ─── PDF ──────────────────────────────────────────────────────────────────────

interface Fragment {
  text: string;
  font: string;
  style: string;
}

// A word is drawn as adjacent fragments so mid-word style changes
// (vigtig**t**) don't gain a space; wrapping only happens between words.
type Word = Fragment[];

function fragmentFont(run: InlineRun, baseBold: boolean): Pick<Fragment, 'font' | 'style'> {
  const bold = baseBold || !!run.bold;
  const style = bold && run.italic ? 'bolditalic' : bold ? 'bold' : run.italic ? 'italic' : 'normal';
  return { font: run.code ? 'courier' : 'helvetica', style };
}

function runsToWords(runs: InlineRun[], baseBold: boolean): Word[] {
  const words: Word[] = [];
  let current: Word = [];
  for (const run of runs) {
    const font = fragmentFont(run, baseBold);
    // Keep separators so a run that starts/ends mid-word glues onto its
    // neighbour, while whitespace anywhere flushes the word.
    for (const piece of run.text.split(/(\s+)/)) {
      if (piece.length === 0) continue;
      if (/\s/.test(piece)) {
        if (current.length > 0) words.push(current);
        current = [];
      } else {
        current.push({ text: piece, ...font });
      }
    }
  }
  if (current.length > 0) words.push(current);
  return words;
}

async function exportPdf(title: string, date: string | null, markdown: string): Promise<NextResponse> {
  const { jsPDF } = await import('jspdf');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const marginLeft = 20;
  const marginRight = 20;
  const pageBottom = 270;
  const pageWidth = doc.internal.pageSize.getWidth();
  const contentWidth = pageWidth - marginLeft - marginRight;
  let y = 20;

  const breakPageIfNeeded = () => {
    if (y > pageBottom) { doc.addPage(); y = 20; }
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(title, marginLeft, y);
  y += 10;

  if (date) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(115, 115, 112);
    doc.text(date, marginLeft, y);
    y += 8;
  }

  doc.setDrawColor(229, 229, 226);
  doc.line(marginLeft, y, pageWidth - marginRight, y);
  y += 8;

  // Draw one logical line's words with per-fragment fonts, wrapping between
  // words and page-breaking between visual lines. Leaves `y` on the baseline
  // after the last visual line (same contract the splitTextToSize loop had).
  const drawWords = (words: Word[], x0: number, width: number, fontSize: number, lineHeight: number) => {
    doc.setFontSize(fontSize);
    doc.setFont('helvetica', 'normal');
    const spaceWidth = doc.getTextWidth(' ');
    breakPageIfNeeded();
    let x = x0;
    for (const word of words) {
      let wordWidth = 0;
      for (const frag of word) {
        doc.setFont(frag.font, frag.style);
        wordWidth += doc.getTextWidth(frag.text);
      }
      if (x > x0 && x + wordWidth > x0 + width) {
        y += lineHeight;
        breakPageIfNeeded();
        x = x0;
      }
      for (const frag of word) {
        doc.setFont(frag.font, frag.style);
        doc.text(frag.text, x, y);
        x += doc.getTextWidth(frag.text);
      }
      x += spaceWidth;
    }
    y += lineHeight;
  };

  const lines = parseLines(markdown);
  if (lines.length === 0) {
    doc.setTextColor(115, 115, 112);
    doc.setFontSize(10);
    doc.text('(ingen indhold)', marginLeft, y);
  }

  for (const line of lines) {
    if (line.kind === 'heading') {
      y += 2;
      doc.setTextColor(15, 15, 14);
      drawWords(runsToWords(line.runs, true), marginLeft, contentWidth, 11, 6);
      y += 1;
      continue;
    }

    doc.setTextColor(61, 61, 58);
    const prefix =
      line.kind === 'bullet' ? '•  ' : line.kind === 'ordered' ? `${line.number}.  ` : '';
    const indent = prefix ? 3 : 0;
    const words = runsToWords(line.runs, false);
    // The marker is glued to the first word so a wrap never strands it alone.
    const markerFrag: Fragment = { text: prefix, font: 'helvetica', style: 'normal' };
    if (prefix) {
      if (words.length > 0) words[0] = [markerFrag, ...words[0]];
      else words.push([markerFrag]);
    }
    drawWords(words, marginLeft + indent, contentWidth - indent, 10, 5.5);
  }

  const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
  return new NextResponse(pdfBuffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="referat.pdf"`,
    },
  });
}

// ─── docx ─────────────────────────────────────────────────────────────────────

async function exportDocx(title: string, date: string | null, markdown: string): Promise<NextResponse> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, BorderStyle, LevelFormat, AlignmentType } =
    await import('docx');

  const lines = parseLines(markdown);

  const toTextRuns = (runs: InlineRun[], extra: { size?: number; color?: string } = {}) =>
    runs.map((r) => new TextRun({
      text: r.text,
      bold: r.bold,
      italics: r.italic,
      ...(r.code ? { font: 'Courier New' } : {}),
      ...extra,
    }));

  const children = [];

  children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, spacing: { after: date ? 200 : 400 } }));
  if (date) {
    children.push(new Paragraph({
      children: [new TextRun({ text: date, size: 18, color: '737370' })],
      spacing: { after: 400 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E5E5E2' } },
    }));
  }

  if (lines.length === 0) {
    children.push(new Paragraph({
      children: [new TextRun({ text: '(ingen indhold)', size: 22, color: '737370' })],
    }));
  }

  for (const line of lines) {
    if (line.kind === 'heading') {
      children.push(new Paragraph({
        children: toTextRuns(line.runs),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 120 },
      }));
    } else {
      children.push(new Paragraph({
        children: toTextRuns(line.runs, { size: 22, color: '3d3d3a' }),
        spacing: { after: 120 },
        ...(line.kind === 'bullet' ? { bullet: { level: 0 } } : {}),
        ...(line.kind === 'ordered' ? { numbering: { reference: `ordered-${line.group}`, level: 0 } } : {}),
      }));
    }
  }

  // One numbering reference per source list, so a second list restarts at 1
  // instead of continuing where the previous one stopped.
  const orderedGroups = [...new Set(
    lines.filter((l): l is Extract<Line, { kind: 'ordered' }> => l.kind === 'ordered').map((l) => l.group),
  )];
  const numbering = {
    config: orderedGroups.map((group) => ({
      reference: `ordered-${group}`,
      levels: [{
        level: 0,
        format: LevelFormat.DECIMAL,
        text: '%1.',
        alignment: AlignmentType.START,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } },
      }],
    })),
  };

  const doc = new Document({
    numbering,
    sections: [{ children }],
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
  });

  const buffer = await Packer.toBuffer(doc);
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="referat.docx"`,
    },
  });
}

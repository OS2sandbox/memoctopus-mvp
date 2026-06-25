import { NextRequest, NextResponse } from 'next/server';
import { MinutesContent } from '@/types';
import { minutesToBody } from '@/lib/minutes-format';

export async function POST(req: NextRequest) {
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

// The rich-text editor serialises soft line breaks as CommonMark hard breaks — a
// trailing backslash before the newline (and a lone "\" for an empty break line).
// Left as-is those backslashes render literally in the export; strip the marker so
// the break renders as the blank line the user sees in the editor.
function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\\(\r?\n)/g, '$1');
}

// ─── Lightweight markdown line classification ────────────────────────────────

type Line =
  | { kind: 'heading'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'text'; text: string };

function parseLines(markdown: string): Line[] {
  return markdown
    .split('\n')
    .map((raw) => raw.trimEnd())
    .filter((l) => l.trim().length > 0)
    .map((l): Line => {
      const heading = l.match(/^#{1,6}\s+(.*)$/);
      if (heading) return { kind: 'heading', text: heading[1].trim() };
      const bullet = l.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) return { kind: 'bullet', text: stripInline(bullet[1]) };
      const ordered = l.match(/^\s*\d+\.\s+(.*)$/);
      if (ordered) return { kind: 'bullet', text: stripInline(ordered[1]) };
      return { kind: 'text', text: stripInline(l) };
    });
}

// Strip the most common inline markdown emphasis markers for plain-text outputs.
function stripInline(s: string): string {
  return s.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/`(.*?)`/g, '$1');
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

async function exportPdf(title: string, date: string | null, markdown: string): Promise<NextResponse> {
  const { jsPDF } = await import('jspdf');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const marginLeft = 20;
  const marginRight = 20;
  const pageWidth = doc.internal.pageSize.getWidth();
  const contentWidth = pageWidth - marginLeft - marginRight;
  let y = 20;

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

  const lines = parseLines(markdown);
  if (lines.length === 0) {
    doc.setTextColor(115, 115, 112);
    doc.text('(ingen indhold)', marginLeft, y);
  }

  for (const line of lines) {
    if (y > 270) { doc.addPage(); y = 20; }

    if (line.kind === 'heading') {
      y += 2;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(15, 15, 14);
      const wrapped = doc.splitTextToSize(line.text, contentWidth) as string[];
      for (const w of wrapped) {
        if (y > 270) { doc.addPage(); y = 20; }
        doc.text(w, marginLeft, y);
        y += 6;
      }
      y += 1;
      continue;
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(61, 61, 58);
    const prefix = line.kind === 'bullet' ? '•  ' : '';
    const indent = line.kind === 'bullet' ? 3 : 0;
    const wrapped = doc.splitTextToSize(prefix + line.text, contentWidth - indent) as string[];
    for (const w of wrapped) {
      if (y > 270) { doc.addPage(); y = 20; }
      doc.text(w, marginLeft + indent, y);
      y += 5.5;
    }
  }

  const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
  return new NextResponse(pdfBuffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="referat.pdf"`,
    },
  });
}

async function exportDocx(title: string, date: string | null, markdown: string): Promise<NextResponse> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, BorderStyle } = await import('docx');

  const children = [];

  children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, spacing: { after: date ? 200 : 400 } }));
  if (date) {
    children.push(new Paragraph({
      children: [new TextRun({ text: date, size: 18, color: '737370' })],
      spacing: { after: 400 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E5E5E2' } },
    }));
  }

  const lines = parseLines(markdown);
  if (lines.length === 0) {
    children.push(new Paragraph({
      children: [new TextRun({ text: '(ingen indhold)', size: 22, color: '737370' })],
    }));
  }

  for (const line of lines) {
    if (line.kind === 'heading') {
      children.push(new Paragraph({ text: line.text, heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 120 } }));
    } else {
      children.push(new Paragraph({
        children: [new TextRun({ text: line.text, size: 22, color: '3d3d3a' })],
        spacing: { after: 120 },
        ...(line.kind === 'bullet' ? { bullet: { level: 0 } } : {}),
      }));
    }
  }

  const doc = new Document({
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

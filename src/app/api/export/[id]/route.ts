import { NextRequest, NextResponse } from 'next/server';
import { MinutesContent, MinutesSection } from '@/types';

export async function POST(req: NextRequest) {
  const body = await req.json() as { title?: string; content?: MinutesContent; format?: string };
  const { title = 'Referat', content, format = 'pdf' } = body;

  if (!content?.sections) {
    return NextResponse.json({ error: 'Missing content' }, { status: 400 });
  }

  if (format === 'pdf') {
    return exportPdf(title, content);
  } else if (format === 'docx') {
    return exportDocx(title, content);
  } else if (format === 'md') {
    return exportMarkdown(title, content);
  }

  return NextResponse.json({ error: 'Unknown format' }, { status: 400 });
}

function exportMarkdown(title: string, content: MinutesContent): NextResponse {
  const lines: string[] = [`# ${title}`, '', `*Genereret: ${new Date().toLocaleDateString('da-DK')}*`, ''];
  for (const section of content.sections as MinutesSection[]) {
    lines.push(`## ${section.label}`, '');
    lines.push(section.content.trim() || '*(ingen indhold)*', '');
  }
  return new NextResponse(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="referat.md"`,
    },
  });
}

async function exportPdf(title: string, content: MinutesContent): Promise<NextResponse> {
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

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(115, 115, 112);
  doc.text(`Genereret: ${new Date().toLocaleDateString('da-DK')}`, marginLeft, y);
  y += 8;

  doc.setDrawColor(229, 229, 226);
  doc.line(marginLeft, y, pageWidth - marginRight, y);
  y += 8;

  for (const section of content.sections) {
    if (y > 260) { doc.addPage(); y = 20; }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 15, 14);
    doc.text(section.label, marginLeft, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(61, 61, 58);

    if (section.content.trim()) {
      const lines = doc.splitTextToSize(section.content, contentWidth) as string[];
      for (const line of lines) {
        if (y > 270) { doc.addPage(); y = 20; }
        doc.text(line, marginLeft, y);
        y += 5.5;
      }
    } else {
      doc.setTextColor(115, 115, 112);
      doc.text('(ingen indhold)', marginLeft, y);
      y += 5.5;
    }
    y += 6;
  }

  const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
  return new NextResponse(pdfBuffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="referat.pdf"`,
    },
  });
}

async function exportDocx(title: string, content: MinutesContent): Promise<NextResponse> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, BorderStyle } = await import('docx');

  const children = [];

  children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, spacing: { after: 200 } }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Genereret: ${new Date().toLocaleDateString('da-DK')}`, size: 18, color: '737370' })],
    spacing: { after: 400 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E5E5E2' } },
  }));

  for (const section of content.sections as MinutesSection[]) {
    children.push(new Paragraph({ text: section.label, heading: HeadingLevel.HEADING_2, spacing: { before: 400, after: 120 } }));

    const lines = section.content.trim()
      ? section.content.split('\n').filter((l) => l.trim())
      : ['(ingen indhold)'];

    for (const line of lines) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line.replace(/^[-*]\s/, ''), size: 22, color: section.content.trim() ? '3d3d3a' : '737370' })],
        spacing: { after: 120 },
        ...(line.match(/^[-*]\s/) ? { bullet: { level: 0 } } : {}),
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

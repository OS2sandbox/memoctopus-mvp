import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { MinutesContent, MinutesSection } from '@/types';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const format = req.nextUrl.searchParams.get('format') ?? 'pdf';

  const meeting = await queryUserSchemaOne<{ id: string; title: string }>(
    session.user.id,
    'SELECT id, title FROM meetings WHERE id = $1',
    [id],
  );
  if (!meeting) return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });

  const minutesRow = await queryUserSchemaOne<{ content: unknown; version: number }>(
    session.user.id,
    'SELECT content, version FROM minutes WHERE meeting_id = $1 ORDER BY version DESC LIMIT 1',
    [id],
  );
  if (!minutesRow) return NextResponse.json({ error: 'No minutes found' }, { status: 404 });

  const content = minutesRow.content as MinutesContent;

  if (format === 'pdf') {
    return exportPdf(meeting.title, content);
  } else if (format === 'docx') {
    return exportDocx(meeting.title, content);
  }

  return NextResponse.json({ error: 'Unknown format' }, { status: 400 });
}

async function exportPdf(title: string, content: MinutesContent): Promise<NextResponse> {
  const { jsPDF } = await import('jspdf');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const marginLeft = 20;
  const marginRight = 20;
  const pageWidth = doc.internal.pageSize.getWidth();
  const contentWidth = pageWidth - marginLeft - marginRight;
  let y = 20;

  // Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(title, marginLeft, y);
  y += 10;

  // Date
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(115, 115, 112);
  doc.text(`Genereret: ${new Date().toLocaleDateString('da-DK')}`, marginLeft, y);
  y += 8;

  // Divider
  doc.setDrawColor(229, 229, 226);
  doc.line(marginLeft, y, pageWidth - marginRight, y);
  y += 8;

  for (const section of content.sections) {
    // Check page break
    if (y > 260) {
      doc.addPage();
      y = 20;
    }

    // Section heading
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 15, 14);
    doc.text(section.label, marginLeft, y);
    y += 6;

    // Section content
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(61, 61, 58);

    if (section.content.trim()) {
      // Split into lines respecting width
      const lines = doc.splitTextToSize(section.content, contentWidth) as string[];
      for (const line of lines) {
        if (y > 270) {
          doc.addPage();
          y = 20;
        }
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
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
    BorderStyle,
  } = await import('docx');

  const children = [];

  // Title
  children.push(
    new Paragraph({
      text: title,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 200 },
    }),
  );

  // Date
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Genereret: ${new Date().toLocaleDateString('da-DK')}`,
          size: 18,
          color: '737370',
        }),
      ],
      spacing: { after: 400 },
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          size: 1,
          color: 'E5E5E2',
        },
      },
    }),
  );

  for (const section of content.sections as MinutesSection[]) {
    // Section heading
    children.push(
      new Paragraph({
        text: section.label,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 120 },
      }),
    );

    // Content paragraphs
    const lines = section.content.trim()
      ? section.content.split('\n').filter((l) => l.trim())
      : ['(ingen indhold)'];

    for (const line of lines) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: line.replace(/^[-*]\s/, ''),
              size: 22,
              color: section.content.trim() ? '3d3d3a' : '737370',
            }),
          ],
          spacing: { after: 120 },
          ...(line.match(/^[-*]\s/) ? { bullet: { level: 0 } } : {}),
        }),
      );
    }
  }

  const doc = new Document({
    sections: [{ children }],
    styles: {
      default: {
        document: {
          run: {
            font: 'Calibri',
            size: 22,
          },
        },
      },
    },
  });

  const buffer = await Packer.toBuffer(doc);
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="referat.docx"`,
    },
  });
}

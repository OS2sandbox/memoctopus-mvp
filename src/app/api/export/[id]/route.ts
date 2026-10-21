import { NextRequest, NextResponse } from 'next/server';
import { MinutesContent } from '@/types';
import { minutesToBody } from '@/lib/minutes-format';
import { withHandler } from '@/lib/api-handler';
import { asEntityUuid, emitAudit } from '@/app/api/meetings/ai-audit';
import { requireAppAccess } from '@/lib/authz/app-access';

async function postHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const access = await requireAppAccess();
  if (access instanceof NextResponse) return access;
  const { session } = access;

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

  if (format !== 'pdf' && format !== 'md') {
    return NextResponse.json({ error: 'Unknown format' }, { status: 400 });
  }

  // The id in the URL is never verified against a meeting, so it becomes an audit
  // entity only when it is a UUID. Title and content are never logged.
  const meetingId = asEntityUuid((await ctx.params).id);
  const audit = (outcome: 'success' | 'error') =>
    emitAudit(req, { type: 'export.download', actorUserId: session.user.id, outcome, entityId: meetingId, details: { format } });

  let res: NextResponse;
  try {
    res = format === 'pdf' ? await exportPdf(docTitle, docDate, markdown) : exportMarkdown(docTitle, docDate, markdown);
  } catch (err) {
    await audit('error');
    throw err;
  }
  await audit('success');
  return res;
}

export const POST = withHandler('export', postHandler);

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

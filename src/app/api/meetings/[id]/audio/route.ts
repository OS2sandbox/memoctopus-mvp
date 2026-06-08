import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import fs from 'fs/promises';
import { auth } from '@/lib/auth';
import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';
import { getAudioFilePath, createAudioReadStream, deleteAudioFile } from '@/lib/audio/storage';
import path from 'path';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const row = await queryUserSchemaOne<{ filename: string }>(
    session.user.id,
    'SELECT filename FROM audio_files WHERE meeting_id = $1 AND deleted_at IS NULL LIMIT 1',
    [id],
  );
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const filepath = getAudioFilePath(session.user.id, row.filename);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filepath);
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const totalSize = stat.size;
  const ext = path.extname(row.filename).toLowerCase();
  const contentType =
    ext === '.mp4' ? 'audio/mp4' : ext === '.ogg' ? 'audio/ogg' : 'audio/webm';

  const rangeHeader = req.headers.get('range');

  if (rangeHeader) {
    const [, rangeStr] = rangeHeader.split('=');
    const [startStr, endStr] = rangeStr.split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? Math.min(parseInt(endStr, 10), totalSize - 1) : totalSize - 1;
    const chunkSize = end - start + 1;

    const stream = createAudioReadStream(session.user.id, row.filename, { start, end });
    const readable = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk) => controller.enqueue(chunk));
        stream.on('end', () => controller.close());
        stream.on('error', (err) => controller.error(err));
      },
      cancel() {
        stream.destroy();
      },
    });

    return new NextResponse(readable, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunkSize),
      },
    });
  }

  const stream = createAudioReadStream(session.user.id, row.filename);
  const readable = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk) => controller.enqueue(chunk));
      stream.on('end', () => controller.close());
      stream.on('error', (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });

  return new NextResponse(readable, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(totalSize),
    },
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rows = await queryUserSchema<{ filename: string }>(
    session.user.id,
    'UPDATE audio_files SET deleted_at = NOW() WHERE meeting_id = $1 AND deleted_at IS NULL RETURNING filename',
    [id],
  );

  await Promise.all(rows.map((r) => deleteAudioFile(session.user.id, r.filename)));

  // Keep 'review' status when a transcript already exists so the transcript
  // remains accessible. Only fall back to 'recording' when there is nothing to show.
  const transcript = await queryUserSchemaOne<{ id: string }>(
    session.user.id,
    'SELECT id FROM transcripts WHERE meeting_id = $1 LIMIT 1',
    [id],
  );

  await queryUserSchema(
    session.user.id,
    transcript
      ? "UPDATE meetings SET status = 'review', updated_at = NOW() WHERE id = $1"
      : "UPDATE meetings SET status = 'recording', updated_at = NOW() WHERE id = $1",
    [id],
  );

  return NextResponse.json({ ok: true, hasTranscript: !!transcript });
}

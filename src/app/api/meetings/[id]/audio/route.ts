import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { readAudioFile } from '@/lib/audio/storage';
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

  let buffer: Buffer;
  try {
    buffer = await readAudioFile(session.user.id, row.filename);
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const ext = path.extname(row.filename).toLowerCase();
  const contentType =
    ext === '.mp4' ? 'audio/mp4' : ext === '.ogg' ? 'audio/ogg' : 'audio/webm';

  const totalSize = buffer.byteLength;
  const rangeHeader = req.headers.get('range');

  if (rangeHeader) {
    const [, rangeStr] = rangeHeader.split('=');
    const [startStr, endStr] = rangeStr.split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : totalSize - 1;
    const chunkLen = end - start + 1;
    const ab = buffer.buffer as ArrayBuffer;
    const chunk = ab.slice(buffer.byteOffset + start, buffer.byteOffset + start + chunkLen);

    return new NextResponse(chunk, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunkLen),
      },
    });
  }

  const ab = buffer.buffer as ArrayBuffer;
  return new NextResponse(ab.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(totalSize),
    },
  });
}

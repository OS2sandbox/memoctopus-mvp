import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { withHandler } from '@/lib/api-handler';
import { concatToMono16kFlac } from '@/lib/audio/concat-server';

// Joins two or more uploaded recordings of one meeting, in form order (repeated
// `audio` fields), into one 16 kHz mono FLAC. The client then runs its ordinary
// single-file upload pipeline on the result. Stateless: nothing is stored, and the
// temp files ffmpeg needs are removed before the response goes out.
export const POST = withHandler('audio/concat', async (req: NextRequest) => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const entries = (await req.formData()).getAll('audio');
  if (entries.length < 2) {
    return NextResponse.json({ error: 'At least two audio files are required' }, { status: 400 });
  }
  const files: File[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' || entry.size === 0) {
      return NextResponse.json({ error: 'Every audio field must be a non-empty file' }, { status: 400 });
    }
    files.push(entry);
  }

  const buffers = await Promise.all(files.map(async (file) => Buffer.from(await file.arrayBuffer())));
  const flac = await concatToMono16kFlac(buffers);

  return new NextResponse(new Uint8Array(flac), {
    status: 200,
    headers: { 'Content-Type': 'audio/flac', 'Cache-Control': 'no-store' },
  });
});

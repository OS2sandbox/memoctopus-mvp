import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: Params) {
  void req;
  void params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text/get-realtime-token', {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model_id: 'scribe_v2_realtime' }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    console.error('ElevenLabs token error:', err);
    return NextResponse.json({ error: 'Failed to get streaming token' }, { status: 500 });
  }

  const data = await res.json() as { token: string };
  return NextResponse.json({ token: data.token });
}

import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { analyzeClarifications } from '@/lib/ai/clarifications';

interface Params {
  params: Promise<{ id: string }>;
}

// Live, non-persisted analysis: given the transcript so far, return a short list
// of things worth clarifying. Called periodically by the recording screen.
export async function POST(req: NextRequest, { params }: Params) {
  const { id: _id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { transcript } = await req.json() as { transcript?: string };
  if (!transcript?.trim()) return NextResponse.json({ clarifications: [] });

  try {
    const clarifications = await analyzeClarifications(transcript);
    return NextResponse.json({ clarifications });
  } catch {
    return NextResponse.json({ clarifications: [] });
  }
}

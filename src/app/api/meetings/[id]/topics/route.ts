import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { analyzeTopics } from '@/lib/ai/topics';

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id: _id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { transcript } = await req.json() as { transcript?: string };
  if (!transcript?.trim()) return NextResponse.json({ topics: [] });

  try {
    const topics = await analyzeTopics(transcript);
    return NextResponse.json({ topics });
  } catch {
    return NextResponse.json({ topics: [] });
  }
}

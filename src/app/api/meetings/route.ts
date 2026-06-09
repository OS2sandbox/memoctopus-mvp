import { NextResponse } from 'next/server';

// Meeting creation and listing are handled client-side via IndexedDB.
// This stub exists for compatibility with any remaining callers.
export async function GET() {
  return NextResponse.json({ count: 0, meetings: [] });
}

export async function POST() {
  return NextResponse.json({ error: 'Use IndexedDB' }, { status: 410 });
}

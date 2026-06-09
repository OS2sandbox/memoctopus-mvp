import { NextResponse } from 'next/server';

// Audio is stored in IndexedDB and served as a blob URL client-side.
export async function GET() {
  return NextResponse.json({ error: 'Audio served from IndexedDB' }, { status: 410 });
}

export async function DELETE() {
  return NextResponse.json({ ok: true });
}

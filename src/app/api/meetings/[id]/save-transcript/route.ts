import { NextResponse } from 'next/server';

// Transcript saving is handled client-side via IndexedDB.
export async function POST() {
  return NextResponse.json({ ok: true });
}

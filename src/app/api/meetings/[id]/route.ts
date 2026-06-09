import { NextResponse } from 'next/server';

// Meeting CRUD is handled client-side via IndexedDB.
export async function GET() {
  return NextResponse.json({ error: 'Use IndexedDB' }, { status: 410 });
}

export async function PATCH() {
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  return NextResponse.json({ ok: true });
}

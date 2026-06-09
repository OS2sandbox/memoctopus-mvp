import { NextResponse } from 'next/server';

// Speaker rename is handled client-side via IndexedDB.
export async function PATCH() {
  return NextResponse.json({ ok: true });
}

import { NextResponse } from 'next/server';

// Minutes saving is handled client-side via IndexedDB.
export async function PATCH() {
  return NextResponse.json({ ok: true });
}

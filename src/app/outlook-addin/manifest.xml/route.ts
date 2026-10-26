import { NextResponse } from 'next/server';
import { outlookAddinConfig } from '@/lib/auth/providers';
import { buildManifest } from '@/lib/outlook/manifest';

/**
 * The add-in's manifest, for the admin to upload in Integrated Apps. Built from
 * BETTER_AUTH_URL, the public URL this server already answers sign-ins on. Only
 * served while the add-in is switched on, so a deployment without it does not
 * hand out a manifest for a button that would only fail.
 */
export async function GET() {
  if (!outlookAddinConfig()) return NextResponse.json({ error: 'disabled' }, { status: 404 });

  const origin = process.env.BETTER_AUTH_URL?.trim();
  let xml: string;
  try {
    xml = buildManifest(origin ?? '');
  } catch (err) {
    console.error('[outlook] cannot build the manifest:', err);
    return NextResponse.json({ error: 'misconfigured' }, { status: 500 });
  }
  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="os2taletiltekst-outlook.xml"',
      'Cache-Control': 'no-store',
    },
  });
}

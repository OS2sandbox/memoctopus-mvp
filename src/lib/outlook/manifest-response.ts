import { NextResponse } from 'next/server';
import { outlookAddinConfig } from '@/lib/auth/providers';
import { buildManifest } from './manifest';

/**
 * The manifest as a download, built from BETTER_AUTH_URL, the public URL this
 * server already answers sign-ins on, and OUTLOOK_ADDIN_ID when a second
 * deployment shares the tenant. Only served while the add-in is switched on, so
 * a deployment without it does not hand out a manifest for a button that would
 * only fail. A malformed OUTLOOK_ADDIN_ID answers 500 rather than a manifest
 * that would collide with the other deployment's add-in.
 */
export function manifestResponse(): NextResponse {
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

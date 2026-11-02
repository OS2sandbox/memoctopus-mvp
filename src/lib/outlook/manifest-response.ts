import { NextResponse } from 'next/server';
import { outlookAddinConfig } from '@/lib/auth/providers';
import { buildManifest, type ManifestVariant } from './manifest';

const FILENAMES: Record<ManifestVariant, string> = {
  production: 'os2taletiltekst-outlook.xml',
  test: 'os2taletiltekst-outlook-test.xml',
};

/**
 * A manifest as a download, built from BETTER_AUTH_URL, the public URL this
 * server already answers sign-ins on. Only served while the add-in is switched
 * on, so a deployment without it does not hand out a manifest for a button that
 * would only fail.
 */
export function manifestResponse(variant: ManifestVariant): NextResponse {
  if (!outlookAddinConfig()) return NextResponse.json({ error: 'disabled' }, { status: 404 });

  const origin = process.env.BETTER_AUTH_URL?.trim();
  let xml: string;
  try {
    xml = buildManifest(origin ?? '', variant);
  } catch (err) {
    console.error('[outlook] cannot build the manifest:', err);
    return NextResponse.json({ error: 'misconfigured' }, { status: 500 });
  }
  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${FILENAMES[variant]}"`,
      'Cache-Control': 'no-store',
    },
  });
}

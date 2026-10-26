import { NextResponse } from 'next/server';
import { outlookAddinConfig } from '@/lib/auth/providers';
import { ADDIN_SCOPE } from '@/lib/outlook/addin-auth';

/**
 * What the Outlook add-in signs in against. Public by design: the app's client
 * id and tenant id are in every sign-in URL the browser already sees, and the
 * add-in has no other way to learn them without baking them into the build.
 */
export async function GET() {
  const config = outlookAddinConfig();
  if (!config) return NextResponse.json({ enabled: false });
  return NextResponse.json({
    enabled: true,
    clientId: config.clientId,
    tenantId: config.tenantId,
    scopes: [`api://${config.clientId}/${ADDIN_SCOPE}`],
  });
}

import { NextResponse } from 'next/server';
import { outlookAddinConfig } from '@/lib/auth/providers';
import { ADDIN_SCOPE } from '@/lib/outlook/addin-auth';
import { deleteRecordingEnabled } from '@/lib/teams/artifact-mode';

/**
 * What the Outlook add-in signs in against. Public by design: the app's client
 * id and tenant id are in every sign-in URL the browser already sees, and the
 * add-in has no other way to learn them without baking them into the build.
 *
 * `token` says which token the add-in sends: `api` an access token for our
 * exposed API, `id` the sign-in app's ID token (see outlookAddinConfig()).
 *
 * `deletesRecording` is for the pane's note on what happens to the recording:
 * it is deleted from OneDrive only while TEAMS_DELETE_RECORDING is on and not in
 * transcript-only mode, and the pane must not promise more than that.
 */
export async function GET() {
  const config = outlookAddinConfig();
  if (!config) return NextResponse.json({ enabled: false });
  return NextResponse.json({
    enabled: true,
    clientId: config.clientId,
    tenantId: config.tenantId,
    token: config.token,
    scopes: config.token === 'id' ? ['openid', 'profile'] : [`api://${config.clientId}/${ADDIN_SCOPE}`],
    deletesRecording: deleteRecordingEnabled(),
  });
}

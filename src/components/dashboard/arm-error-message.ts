/**
 * Danish copy for an error answer from `POST /api/teams/meetings`.
 *
 * The server sends a Danish, user-safe `message` with every typed error (see
 * src/lib/teams/http-errors.ts), so that comes first: a client-side list of codes
 * falls behind the server's every time a code is added. The list below covers the
 * answers that carry no message — the route's own validation and the session
 * check — and keeps a sensible sentence for anything else.
 *
 * Kept as its own pure module rather than inside a component: it is UI copy, so
 * it does not belong under src/lib/teams (whose modules reach the database and
 * better-auth), but its only consumer is the dashboard's mødelink box and it is
 * worth testing without rendering anything.
 */
export function armErrorMessage(
  status: number,
  body: { error?: string; message?: string } = {},
): string {
  const message = body.message?.trim();
  if (message) return message;

  switch (body.error) {
    case 'invalid-url':
    case 'wrong-host':
      return 'Mødelinket er ikke et gyldigt Teams-link.';
    case 'not_invited':
      return 'Du skal være inviteret til mødet for at kunne tage referat.';
    case 'disabled':
      return 'Teams-integrationen er ikke slået til.';
    case 'consent_required':
      return 'OS2taletiltekst mangler adgang til dine Teams-møder. Log ind med Microsoft igen.';
    case 'reauth_required':
      return 'Din adgang til Microsoft er udløbet. Log ind med Microsoft igen.';
    case 'transcripts_disabled':
      return 'Jeres Teams-opsætning tillader ikke, at OS2taletiltekst henter transskriptioner. Kontakt jeres IT-administrator.';
    default:
      return status === 401
        ? 'Du er ikke logget ind længere. Genindlæs siden.'
        : 'Kunne ikke slå referat til for mødet. Prøv igen.';
  }
}

import { NextRequest, NextResponse } from 'next/server';

/**
 * Query parameter the (app) layout and the admin page gates (authz/page-gate.ts, SESSION_EXPIRED_URL) set when
 * they reject a session cookie the middleware let through, to break the redirect loop the two checks would
 * otherwise form. `session_expired` is the name an earlier version used; it is still honoured.
 */
export const SESSION_EXPIRED_PARAM = 'expired';
const SESSION_EXPIRED_PARAMS = [SESSION_EXPIRED_PARAM, 'session_expired'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Presence check only — token validity is enforced by auth.api.getSession() in each route handler.
  // This redirect is a UX guard, not a security gate.
  const sessionToken =
    req.cookies.get('better-auth.session_token')?.value ||
    req.cookies.get('__Secure-better-auth.session_token')?.value;

  // Legacy sign-in route — redirect to landing page.
  if (pathname === '/sign-in') {
    return NextResponse.redirect(new URL('/', req.url));
  }

  // Landing page is public — authenticated users go straight to the dashboard.
  if (pathname === '/') {
    // `?expired=1` is where the (app) layout and the admin page gates send a request whose cookie no longer
    // maps to a session (expired, deleted because the person was disabled, secret rotation, a restored
    // database, or another app on a different port of the same host: cookies ignore port). Presence here and
    // validity there are different questions, and bouncing such a request to /dashboard only to be sent back
    // is an infinite redirect loop that locks the user out of the login page. So the landing page is served,
    // and the dead cookie is dropped.
    if (sessionToken && SESSION_EXPIRED_PARAMS.some((name) => req.nextUrl.searchParams.has(name))) {
      const res = NextResponse.next();
      // A cookie is only removed by a Set-Cookie that matches how it was set. The `__Secure-` variant
      // is only ever accepted (or deleted) with the Secure attribute, so a plain delete would leave it
      // in the browser and `/` -> `/dashboard` -> `/?expired=1` would loop. The plain-named one carries
      // Secure whenever the app is served over https.
      const expired = { value: '', maxAge: 0, path: '/', httpOnly: true, sameSite: 'lax' as const };
      res.cookies.set({ ...expired, name: '__Secure-better-auth.session_token', secure: true });
      res.cookies.set({ ...expired, name: 'better-auth.session_token', secure: req.nextUrl.protocol === 'https:' });
      return res;
    }
    if (sessionToken) {
      return NextResponse.redirect(new URL('/dashboard', req.url));
    }
    return NextResponse.next();
  }

  if (!sessionToken) {
    const homeUrl = new URL('/', req.url);
    homeUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(homeUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Exclude API routes, Next internals, and any request for a file with an
    // extension. Static assets in public/ are served from the ROOT (e.g.
    // /silero_vad_v5.onnx, /ort-wasm-*.wasm, /vad.worklet.bundle.min.js), not
    // under /public/, so the old `public` token never matched them — they got
    // auth-redirected to the login HTML, which made the in-browser VAD fail to
    // initialize and recordings silently produce no transcript.
    '/((?!api/|_next/static|_next/image|favicon|.*\\..*).*)',
  ],
};

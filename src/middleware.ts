import { NextRequest, NextResponse } from 'next/server';

/**
 * Set by the (app) layout when it rejects a session cookie the middleware let
 * through, to break the redirect loop the two checks would otherwise form.
 * Shared with src/app/(app)/layout.tsx.
 */
export const SESSION_EXPIRED_PARAM = 'session_expired';

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
    // ...unless the (app) layout just rejected this very cookie. Presence here and
    // validity there are different questions, and a cookie that outlives its
    // session row (secret rotation, a restored database, a deleted session, or
    // another app on a different port of the same host — cookies ignore port)
    // answers them differently. Bouncing such a request to /dashboard only to be
    // sent back is an infinite redirect loop that locks the user out of the login
    // page entirely, so honour the marker and render the landing page.
    if (sessionToken && !req.nextUrl.searchParams.has(SESSION_EXPIRED_PARAM)) {
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

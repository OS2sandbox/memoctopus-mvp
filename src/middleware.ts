import { NextRequest, NextResponse } from 'next/server';

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
    // `?expired=1` is where the (app) layout sends a request whose cookie no longer maps to
    // a session (expired, or deleted because the person was disabled). Passing it through,
    // and dropping the dead cookie, is what stops `/` and `/dashboard` redirecting to each other.
    if (sessionToken && req.nextUrl.searchParams.has('expired')) {
      const res = NextResponse.next();
      res.cookies.delete('better-auth.session_token');
      res.cookies.delete('__Secure-better-auth.session_token');
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

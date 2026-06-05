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
    '/((?!api/|_next/static|_next/image|favicon|public).*)',
  ],
};

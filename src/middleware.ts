import { NextRequest, NextResponse } from 'next/server';

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Check for a valid better-auth session cookie
  const sessionToken =
    req.cookies.get('better-auth.session_token')?.value ||
    req.cookies.get('__Secure-better-auth.session_token')?.value;

  if (!sessionToken) {
    const signIn = new URL('/sign-in', req.url);
    signIn.searchParams.set('from', pathname);
    return NextResponse.redirect(signIn);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!sign-in|api/auth|_next/static|_next/image|favicon|public).*)',
  ],
};

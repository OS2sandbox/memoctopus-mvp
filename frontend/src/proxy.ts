import { getSessionCookie } from "better-auth/cookies";

import { type NextRequest, NextResponse } from "next/server";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rewrite /v1/* to /api/v1/* for the proxy routes
  if (pathname.startsWith("/v1/")) {
    const url = request.nextUrl.clone();
    url.pathname = `/api${pathname}`;
    return NextResponse.rewrite(url);
  }

  // Auth gate for protected routes
  if (pathname.startsWith("/app")) {
    const session = getSessionCookie(request);

    if (session) {
      return NextResponse.next();
    }

    const signInUrl = new URL("/sign-in", request.url);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*", "/v1/:path*"],
};

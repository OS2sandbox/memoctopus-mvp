import { getSessionCookie } from "better-auth/cookies";

import { type NextRequest, NextResponse } from "next/server";

// const DISABLE_AUTH = process.env["DISABLE_AUTH"] === "true"
// acts as a gatekeeper for protected routes; authorization gate
export async function middleware(request: NextRequest) {
  const session = getSessionCookie(request);

  if (session) {
    return NextResponse.next();
  }

  const signInUrl = new URL("/sign-in", request.url);
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: ["/app/:path*"],
};

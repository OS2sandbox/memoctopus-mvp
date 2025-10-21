import { getSession } from "@/lib/auth-client";

import { type NextRequest, NextResponse } from "next/server";

// acts as a gatekeeper for protected routes; authorization gate
export async function middleware(request: NextRequest) {
  const session = await getSession();

  if (session?.data?.user) {
    return NextResponse.next();
  }

  const signInUrl = new URL("/", request.url);
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: ["/app/:path*", "/auth/:path*"],
};

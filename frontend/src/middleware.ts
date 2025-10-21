import { getSession } from "@/lib/auth-client";

import { type NextRequest, NextResponse } from "next/server";

// const DISABLE_AUTH = process.env["DISABLE_AUTH"] === "true"
// acts as a gatekeeper for protected routes; authorization gate
export async function middleware(request: NextRequest) {
  const session = await getSession();

  if (session?.data?.user || process.env.NODE_ENV === "development") {
    return NextResponse.next();
  }

  const signInUrl = new URL("/sign-in", request.url);
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: ["/app/:path*"],
};

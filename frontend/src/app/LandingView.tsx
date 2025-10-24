"use client";

import { useSession } from "@/lib/auth-client";

import Link from "next/link";

export const LandingView = () => {
  const { data: session } = useSession();
  const isAuthenticated = !!session?.user;

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center p-24">
      <div className="z-10 max-w-5xl w-full items-center justify-between font-mono text-sm">
        <h1 className="text-4xl font-bold mb-8 text-center">
          Welcome to MemOctopus
        </h1>
        {isAuthenticated ? (
          <div className="flex flex-col items-center gap-4">
            <p className="text-lg text-muted-foreground text-center">
              You are signed in! Click below to access your dashboard.
            </p>
            <Link
              href="/app"
              className="rounded-md bg-primary px-6 py-3 text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Go to Dashboard
            </Link>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <p className="text-lg text-muted-foreground text-center">
              Please sign in to continue
            </p>
            <Link
              href="/sign-in"
              className="rounded-md bg-primary px-6 py-3 text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Sign In
            </Link>
          </div>
        )}
      </div>
    </div>
  );
};

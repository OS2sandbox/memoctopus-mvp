import { SignedIn, SignedOut } from "@/components/auth/auth-components";
import Link from "next/link";
import { NavBar } from "@/components/NavBar";

export default function LandingPage() {
  return (
    <>
      <NavBar />
      <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center p-24">
      <div className="z-10 max-w-5xl w-full items-center justify-between font-mono text-sm">
        <h1 className="text-4xl font-bold mb-8 text-center">
          Welcome to MemOctopus
        </h1>

        <SignedOut>
          <div className="flex flex-col items-center gap-4">
            <p className="text-lg text-muted-foreground text-center">
              Please sign in to continue
            </p>
            <Link
              href="/auth/sign-in"
              className="rounded-md bg-primary px-6 py-3 text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Sign In
            </Link>
          </div>
        </SignedOut>

          { /* Just redirect to (dashboard) if already logged in. */}
        <SignedIn>
          <div className="flex flex-col items-center gap-4">
            <p className="text-lg text-muted-foreground text-center">
              You are signed in!
            </p>
            <Link
              href="/dashboard"
              className="rounded-md bg-primary px-6 py-3 text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Go to Dashboard
            </Link>
          </div>
        </SignedIn>
      </div>
    </main>
    </>
  );
}

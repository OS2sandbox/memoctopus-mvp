"use client";

import { useSession } from "@/lib/auth-client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export const LandingView = () => {
  const { data: session, isPending } = useSession();
  const isAuthenticated = !!session?.user;
  const router = useRouter();

  useEffect(() => {
    if (isAuthenticated) {
      router.push("/app");
    }
  }, [isAuthenticated, router]);

  return (
    <div className="flex items-center justify-center p-24">
      <div className="z-10 max-w-5xl w-full text-center">
        <h1 className="text-4xl font-bold mb-8">Welcome to MemOctopus</h1>
        <div className="flex flex-col items-center gap-4">
          <p className="text-lg text-muted-foreground">
            {isPending
              ? "Tjekker, om du er logget ind..."
              : isAuthenticated
                ? "Fører dig til dashboard..."
                : "Venligst log ind for at fortsætte."}
          </p>
          {!isPending && !isAuthenticated && (
            <Link
              href="/sign-in"
              className="rounded-md bg-primary px-6 py-3 text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Log ind
            </Link>
          )}
        </div>
      </div>
    </div>
  );
};

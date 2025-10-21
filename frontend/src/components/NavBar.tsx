"use client";

import type { User } from "better-auth";

import { authClient, signOut } from "@/lib/auth-client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function NavBar() {
  const [user, setUser] = useState<User>(null);
  const router = useRouter();

  useEffect(() => {
    authClient.getSession().then((session) => {
      if (session.data) {
        setUser(session.data.user);
      }
    });
  }, []);

  // TODO: Turn the dashboard links into a factory pattern
  return (
    <nav className="border-b border-border bg-background">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <Link href="/" className="text-xl font-bold">
          MemOctopus
        </Link>

        <div className="flex items-center gap-4">
          <Link
            href="/app"
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Dashboard
          </Link>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {user?.name || user?.email || "User"}
            </span>
            <button
              onClick={async () => {
                await signOut({
                  fetchOptions: {
                    onSuccess: () => {
                      router.push("/sign-in");
                    },
                  },
                });
              }}
              className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}

"use client";

import type { User } from "better-auth";

import { RedirectToSignIn, SignedIn } from "@/components/custom/auth/auth-components";
import { authClient } from "@/lib/auth-client";

import { useEffect, useState } from "react";

export default function DashboardPage() {
  const [user, setUser] = useState<User>(null);

  useEffect(() => {
    authClient.getSession().then((session) => {
      if (session.data) {
        setUser(session.data.user);
      }
    });
  }, []);

  return (
    <>
      <RedirectToSignIn />

      <SignedIn>
        <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center p-24">
          <div className="z-10 max-w-5xl w-full items-center justify-between font-mono text-sm">
            <h1 className="text-4xl font-bold mb-8 text-center">Dashboard</h1>

            <div className="rounded-lg border border-border bg-card p-8 shadow-sm">
              <h2 className="text-2xl font-semibold mb-4">
                Welcome, {user?.name || user?.email || "User"}
              </h2>

              <div className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground">Email</p>
                  <p className="text-base">{user?.email || "Loading..."}</p>
                </div>

                {user?.name && (
                  <div>
                    <p className="text-sm text-muted-foreground">Name</p>
                    <p className="text-base">{user.name}</p>
                  </div>
                )}

                <div>
                  <p className="text-sm text-muted-foreground">User ID</p>
                  <p className="text-base font-mono text-xs">
                    {user?.id || "Loading..."}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </SignedIn>
    </>
  );
}

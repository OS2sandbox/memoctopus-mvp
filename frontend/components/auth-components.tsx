"use client";

import { useEffect, useState, ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";

export function SignedIn({ children }: { children: ReactNode }) {
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    authClient.getSession().then((session: any) => {
      setIsSignedIn(!!session.data);
      setIsLoading(false);
    });
  }, []);

  if (isLoading) return null;
  if (!isSignedIn) return null;

  return <>{children}</>;
}

export function SignedOut({ children }: { children: ReactNode }) {
  const [isSignedOut, setIsSignedOut] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    authClient.getSession().then((session: any) => {
      setIsSignedOut(!session.data);
      setIsLoading(false);
    });
  }, []);

  if (isLoading) return null;
  if (!isSignedOut) return null;

  return <>{children}</>;
}

export function RedirectToSignIn() {
  const router = useRouter();
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    authClient.getSession().then((session: any) => {
      if (!session.data) {
        router.push("/auth/sign-in");
      }
      setIsChecking(false);
    });
  }, [router]);

  if (isChecking) return <div>Loading...</div>;

  return null;
}

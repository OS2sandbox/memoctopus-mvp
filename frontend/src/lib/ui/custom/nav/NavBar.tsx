"use client";

import { ProfileOverview } from "@/lib/ui/custom/profile/ProfileOverview";

import Link from "next/link";

export const NavBar = () => {
  return (
    <nav className="fixed top-0 left-0 right-0 z-10 border-b border-border bg-background">
      <div className="container mx-auto grid h-16 grid-cols-[1fr_auto_1fr] items-center px-4">
        <Link href="/app" className="text-xl font-bold">
          MemOctopus
        </Link>

        <div className="flex justify-center items-center gap-6">
          <Link
            href="/app/library"
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Prompter
          </Link>
          <Link
            href="/app/history"
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Historik
          </Link>
          <Link
            href="/app/about"
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Om
          </Link>
        </div>

        <div className="flex justify-end items-center gap-3">
          <ProfileOverview />
        </div>
      </div>
    </nav>
  );
};

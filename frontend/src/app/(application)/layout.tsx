import type { ReactNode } from "react";

import { NavBar } from "@/components/NavBar";

export default function ApplicationLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <>
      <NavBar />
      {children}
    </>
  );
}

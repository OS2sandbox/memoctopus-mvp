import { NavBar } from "@/lib/ui/custom/nav/NavBar";

import { Fragment, type ReactNode } from "react";

export default function ApplicationLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <Fragment>
      <NavBar />
      {children}
      <footer className="fixed bottom-0 right-0 p-2 text-xs text-muted-foreground">
        v{process.env["APP_VERSION"]}
      </footer>
    </Fragment>
  );
}

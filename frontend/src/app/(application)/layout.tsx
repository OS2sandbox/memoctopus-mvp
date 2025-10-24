import { NavBar } from "@/components/custom/nav/NavBar";

import { Fragment, type ReactNode } from "react";

export default function ApplicationLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <Fragment>
      <NavBar />
      {children}
    </Fragment>
  );
}

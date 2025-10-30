import type { Metadata } from "next";

import { Inter } from "next/font/google";
import "./globals.css";

import type { ReactNode } from "react";

import { Providers } from "@/components/providers";
import { cn } from "@/lib/utils";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "MemOctopus - Authentication",
  description: "Sign in to MemOctopus",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={cn(inter.className, "pt-20")}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

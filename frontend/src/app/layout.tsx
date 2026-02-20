import type { Metadata } from "next";

import { Inter } from "next/font/google";
import "./globals.css";

import { ReactQueryDevtools } from "@tanstack/react-query-devtools";

import type { ReactNode } from "react";

import { ReactQueryProvider } from "@/app/providers/ReactQueryProvider";
import { cn } from "@/lib/utils/utils";

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
      <body className={cn(inter.className)}>
        <div className="pt-20 min-h-screen flex flex-col">
          <ReactQueryProvider>
            {children}
            <ReactQueryDevtools initialIsOpen={false} />
          </ReactQueryProvider>
        </div>
      </body>
    </html>
  );
}

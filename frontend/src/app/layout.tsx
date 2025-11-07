import type { Metadata } from "next";

import { Inter } from "next/font/google";
import "./globals.css";

import { ReactQueryDevtools } from "@tanstack/react-query-devtools";

import type { ReactNode } from "react";

import { ReactQueryProvider } from "@/app/providers/ReactQueryProvider";
import { cn } from "@/lib/utils";
import { StartMockWorker } from "@/mocks/StartMockWorker";

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
        <ReactQueryProvider>
          <StartMockWorker>{children}</StartMockWorker>
          <ReactQueryDevtools initialIsOpen={false} />
        </ReactQueryProvider>
      </body>
    </html>
  );
}

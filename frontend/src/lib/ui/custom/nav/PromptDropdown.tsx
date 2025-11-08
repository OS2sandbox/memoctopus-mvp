"use client";

import { Button } from "@/lib/ui/core/shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/lib/ui/core/shadcn/dropdown-menu";

import Link from "next/link";

// TODO: Make a new component for dropdown menu items with description
export function PromptDropdown() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Prompts</Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="flex flex-row justify-start items-stretch w-auto px-2 py-2"
        align="start"
      >
        <DropdownMenuItem asChild className="p-0 items-start">
          <Link
            href="/app/library"
            className="flex flex-col space-y-0.5 p-1.5 w-40"
          >
            <span className="font-medium text-sm">Prompt-bibliotek</span>
            <span className="text-xs text-muted-foreground">
              Indeholder alle dine egne prompts og dem, som dine kollegaer har
              delt.
            </span>
          </Link>
        </DropdownMenuItem>

        <DropdownMenuItem asChild className="p-0 items-start">
          <Link
            href="/app/new-prompt"
            className="flex flex-col space-y-0.5 p-1.5 w-40"
          >
            <span className="font-medium text-sm">Opret ny prompt</span>
            <span className="text-xs text-muted-foreground">
              Lav et prompt, der giver de opsummeringer, der passer til dit
              møde.
            </span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

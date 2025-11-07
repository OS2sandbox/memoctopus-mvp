"use client";

import { useQuery } from "@tanstack/react-query";

import { getPrompts } from "@/lib/api/prompts";
import { PromptTable } from "@/lib/ui/custom/prompt-library/table/PromptTable";

export const LibraryView = () => {
  const query = useQuery({ queryKey: ["prompts"], queryFn: getPrompts });
  const mockPrompts = query.data ?? [];

  console.log("Prompts data:", mockPrompts);

  return (
    <main className="min-h-screen flex flex-col items-center px-6 py-16 space-y-6">
      <h1 className="text-2xl font-semibold">Prompt-bibliotek</h1>
      <div className="flex flex-col w-full items-center justify-center pb-4">
        <p>Find et prompt og tilføj det til dine prompts.</p>
        <p>Du kan også oprette et nyt prompt.</p>
      </div>

      <PromptTable data={mockPrompts} />
    </main>
  );
};

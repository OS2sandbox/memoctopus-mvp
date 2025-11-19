"use client";

import { useQuery } from "@tanstack/react-query";

import { getPrompts } from "@/lib/api/prompts";
import { Spinner } from "@/lib/ui/core/shadcn/spinner";
import { PromptTable } from "@/lib/ui/custom/prompt-library/table/PromptTable";

export const LibraryView = () => {
  const { data, status } = useQuery({
    queryKey: ["prompts"],
    queryFn: getPrompts,
  });

  const renderContent = () => {
    switch (status) {
      case "error":
        return <p>Der opstod en fejl ved hentning af prompts.</p>;
      case "pending":
        return <Spinner />;
      case "success":
        return <PromptTable data={data} />;
      default:
        return null;
    }
  };

  return (
    <section className="min-h-screen flex flex-col items-center px-6 py-16 space-y-6">
      <h1 className="text-2xl font-semibold">Prompt-bibliotek</h1>
      <div className="flex flex-col w-full items-center justify-center pb-4">
        <p>Find en prompt og tilføj det til dine prompter.</p>
        <p>Du kan også oprette et nyt prompt.</p>
      </div>
      {renderContent()}
    </section>
  );
};

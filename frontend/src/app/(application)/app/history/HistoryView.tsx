"use client";

import { useQuery } from "@tanstack/react-query";

import { getHistoryEntries } from "@/lib/api/history-entry";
import { Spinner } from "@/lib/ui/core/shadcn/spinner";
import { HistoryTable } from "@/lib/ui/custom/history/table/HistoryTable";

export const HistoryView = () => {
  const { data, status } = useQuery({
    queryKey: ["historyEntries"],
    queryFn: getHistoryEntries,
  });

  const renderContent = () => {
    switch (status) {
      case "error":
        return <p>Der opstod en fejl ved hentning af historik.</p>;
      case "pending":
        return <Spinner />;
      case "success":
        return <HistoryTable data={data}></HistoryTable>;
      default:
        return null;
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center px-6 py-16 space-y-12">
      <section className="min-h-screen flex flex-col items-center px-6 py-16 space-y-6">
        <h1 className="text-2xl font-semibold">Prompt-bibliotek</h1>
        <div className="flex flex-col w-full items-center justify-center pb-4">
          <p>Find et prompt og tilføj det til dine prompts.</p>
          <p>Du kan også oprette et nyt prompt.</p>
        </div>
        {renderContent()}
      </section>
    </main>
  );
};

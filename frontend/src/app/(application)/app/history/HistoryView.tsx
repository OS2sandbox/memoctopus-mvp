"use client";

import { useCurrentUser } from "@/lib/hooks/use-current-user";
import { HistoryTable } from "@/lib/ui/custom/history/table/HistoryTable";
import type { HistoryEntry } from "@/shared/schemas/history";

export const HistoryView = () => {
  const { user } = useCurrentUser();

  const data: HistoryEntry[] = [
    {
      id: "1",
      userId: user?.id || "unknown",
      createdAt: new Date(),
      title: "lolcat prompt",
      assets: [{ kind: "text", text: "lol" }],
    },
  ];

  return (
    <main className="min-h-screen flex flex-col items-center px-6 py-16 space-y-12">
      <section className="min-h-screen flex flex-col items-center px-6 py-16 space-y-6">
        <h1 className="text-2xl font-semibold">Prompt-bibliotek</h1>
        <div className="flex flex-col w-full items-center justify-center pb-4">
          <p>Find et prompt og tilføj det til dine prompts.</p>
          <p>Du kan også oprette et nyt prompt.</p>
        </div>
        <HistoryTable data={data}></HistoryTable>
      </section>
    </main>
  );
};

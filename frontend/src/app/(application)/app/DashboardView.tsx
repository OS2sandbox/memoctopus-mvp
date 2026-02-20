"use client";

import { useQuery } from "@tanstack/react-query";

import { getHistoryEntry } from "@/lib/api/history-entry";
import { Spinner } from "@/lib/ui/core/shadcn/spinner";
import { Wizard } from "@/lib/ui/custom/wizard/Wizard";

import { useSearchParams } from "next/navigation";

export const DashboardView = () => {
  const searchParams = useSearchParams();
  const fromHistoryId = searchParams.get("fromHistory");

  const { data: historyEntry, isLoading } = useQuery({
    queryKey: ["historyEntry", fromHistoryId],
    queryFn: () => getHistoryEntry(fromHistoryId!),
    enabled: !!fromHistoryId,
  });

  if (fromHistoryId && isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Spinner />
      </div>
    );
  }

  // Extract the summary/referat from the history entry (stored as "transcript" kind)
  const transcriptionFromHistory = historyEntry?.assets.find(
    (asset) => asset.kind === "transcript",
  )?.text;

  return (
    <Wizard
      initialTranscription={transcriptionFromHistory}
      startAtSelectPrompt={!!transcriptionFromHistory}
    />
  );
};

import type { HistoryEntry } from "@/lib/schemas/history";
import { DataTable } from "@/lib/ui/core/shadcn/data-table/data-table";
import { getHistoryColumns } from "@/lib/ui/custom/history/table/HistoryColumns";

import { useRouter } from "next/navigation";

interface HistoryTableProps {
  data: HistoryEntry[];
}

export const HistoryTable = ({ data }: HistoryTableProps) => {
  const router = useRouter();

  const handleGenerateNewSummary = (entryId: string) => {
    router.push(`/app?fromHistory=${entryId}`);
  };

  const handleCopyTranscription = async (entry: HistoryEntry) => {
    const transcriptAsset = entry.assets.find(
      (asset) => asset.kind === "transcript",
    );
    if (transcriptAsset) {
      await navigator.clipboard.writeText(transcriptAsset.text);
    }
  };

  const handleCopySummary = async (entry: HistoryEntry) => {
    const promptAsset = entry.assets.find((asset) => asset.kind === "prompt");
    if (promptAsset) {
      await navigator.clipboard.writeText(promptAsset.text);
    }
  };

  const columns = getHistoryColumns({
    handleGenerateNewSummary,
    handleCopyTranscription,
    handleCopySummary,
  });

  return (
    <DataTable<HistoryEntry, typeof columns>
      className={"max-w-4xl"}
      columns={columns}
      data={data}
      searchConfig={{ filterKey: "title", placeholder: "Søg i historik..." }}
    />
  );
};

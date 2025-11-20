import type { HistoryEntry } from "@/lib/schemas/history";
import { DataTable } from "@/lib/ui/core/shadcn/data-table/data-table";
import { getHistoryColumns } from "@/lib/ui/custom/history/table/HistoryColumns";

interface HistoryTableProps {
  data: HistoryEntry[];
}

export const HistoryTable = ({ data }: HistoryTableProps) => {
  // placeholders for action handlers until integrated with backend logic

  const columns = getHistoryColumns({
    handleGenerateTranscript: (promptText: string) => {
      console.log("Generate clicked for:", promptText);
    },
    handleDownloadTranscript: (promptText: string) => {
      console.log("Copy Prompt clicked for:", promptText);
    },
    handleDownloadSummary: (promptText: string) => {
      console.log("Download Text clicked for:", promptText);
    },
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

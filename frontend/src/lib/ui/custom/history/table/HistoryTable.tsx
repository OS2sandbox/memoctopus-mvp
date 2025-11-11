import { DataTable } from "@/lib/ui/core/data-table";
import { getHistoryColumns } from "@/lib/ui/custom/history/table/HistoryColumns";
import type { HistoryEntry } from "@/shared/schemas/history";

interface HistoryTableProps {
  data: HistoryEntry[];
}

export const HistoryTable = ({ data }: HistoryTableProps) => {
  const columns = getHistoryColumns({
    handleGenerate: (promptText: string) => {
      console.log("Generate clicked for:", promptText);
    },
    handleDownloadAudio: (promptText: string) => {
      console.log("Download Audio clicked for:", promptText);
    },
    handleDownloadText: (promptText: string) => {
      console.log("Download Text clicked for:", promptText);
    },
  });

  return <DataTable className={"max-w-2xl"} columns={columns} data={data} />;
};

import { DataTable } from "@/lib/ui/core/data-table";
import { getHistoryColumns } from "@/lib/ui/custom/history/table/HistoryColumns";
import { cn } from "@/lib/utils/utils";
import type { HistoryEntry } from "@/shared/schemas/history";

interface HistoryTableProps {
  data: HistoryEntry[];
  className?: string;
}

export const HistoryTable = ({ data, className }: HistoryTableProps) => {
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

  return (
    <div className={cn("space-y-4 w-full max-w-5xl", className)}>
      <DataTable columns={columns} data={data} />
    </div>
  );
};

import type { ColumnDef } from "@tanstack/react-table";
import {
  LucideCheck,
  LucideClipboardCopy,
  LucideFileText,
  LucidePlus,
} from "lucide-react";

import type { HistoryEntry } from "@/lib/schemas/history";
import { Button } from "@/lib/ui/core/shadcn/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/lib/ui/core/shadcn/tooltip";

import { useState } from "react";

interface CopyButtonProps {
  onClick: () => Promise<void>;
  icon: React.ReactNode;
  tooltipText: string;
}

const CopyButton = ({ onClick, icon, tooltipText }: CopyButtonProps) => {
  const [copied, setCopied] = useState(false);

  const handleClick = async () => {
    await onClick();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={handleClick}>
          {copied ? <LucideCheck className="text-green-600" /> : icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Kopieret!" : tooltipText}</TooltipContent>
    </Tooltip>
  );
};

interface GetHistoryColumnsProps {
  handleGenerateNewSummary: (entryId: string) => void;
  handleCopyTranscription: (entry: HistoryEntry) => Promise<void>;
  handleCopySummary: (entry: HistoryEntry) => Promise<void>;
}

export const getHistoryColumns = ({
  handleGenerateNewSummary,
  handleCopyTranscription,
  handleCopySummary,
}: GetHistoryColumnsProps): ColumnDef<HistoryEntry>[] => [
  {
    accessorKey: "title",
    header: "Titel",
    cell: ({ row }) => (
      <div className="font-medium text-foreground">{row.original.title}</div>
    ),
  },
  {
    accessorKey: "createdAt",
    header: "Dato",
    cell: ({ row }) => (
      <div className="font-medium text-foreground">
        {row.original.createdAt.toDateString()}
      </div>
    ),
  },
  {
    id: "actions",
    cell: ({ row }) => {
      const entry = row.original;

      return (
        <div data-row-action className="flex items-center justify-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleGenerateNewSummary(entry.id)}
              >
                <LucidePlus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Generer nyt referat</TooltipContent>
          </Tooltip>

          <CopyButton
            onClick={() => handleCopyTranscription(entry)}
            icon={<LucideFileText />}
            tooltipText="Kopiér transskribering"
          />

          <CopyButton
            onClick={() => handleCopySummary(entry)}
            icon={<LucideClipboardCopy />}
            tooltipText="Kopiér referat"
          />
        </div>
      );
    },
  },
];

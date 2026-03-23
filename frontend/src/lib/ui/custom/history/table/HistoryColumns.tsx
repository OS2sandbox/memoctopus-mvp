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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/lib/ui/core/shadcn/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/lib/ui/core/shadcn/tooltip";

import { Fragment, useState } from "react";

interface ViewContentButtonProps {
  content: string;
  icon: React.ReactNode;
  tooltipText: string;
}

const ViewContentButton = ({
  content,
  icon,
  tooltipText,
}: ViewContentButtonProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon">
              {icon}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
      <PopoverContent className="max-h-64 overflow-y-auto w-80">
        <p className="text-sm whitespace-pre-wrap">{content}</p>
        <div className="flex justify-start mt-4 items-center">
          <Button size="sm" onClick={handleCopy}>
            {copied ? (
              <Fragment>
                <LucideCheck className="mr-2 h-4 w-4" />
                <span>Kopieret!</span>
              </Fragment>
            ) : (
              <Fragment>
                <LucideClipboardCopy className="mr-2 h-4 w-4" />
                <span>Kopier</span>
              </Fragment>
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

interface GetHistoryColumnsProps {
  handleGenerateNewSummary: (entryId: string) => void;
  getTranscriptionText: (entry: HistoryEntry) => string;
  getSummaryText: (entry: HistoryEntry) => string;
}

export const getHistoryColumns = ({
  handleGenerateNewSummary,
  getTranscriptionText,
  getSummaryText,
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
      const transcriptionText = getTranscriptionText(entry);
      const summaryText = getSummaryText(entry);

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

          {transcriptionText && (
            <ViewContentButton
              content={transcriptionText}
              icon={<LucideFileText />}
              tooltipText="Se transskribering"
            />
          )}

          {summaryText && (
            <ViewContentButton
              content={summaryText}
              icon={<LucideClipboardCopy />}
              tooltipText="Se referat"
            />
          )}
        </div>
      );
    },
  },
];

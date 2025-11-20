import type { ColumnDef } from "@tanstack/react-table";
import { LucideFileDown, LucideFileText } from "lucide-react";

import type { HistoryEntry } from "@/lib/schemas/history";
import { Button } from "@/lib/ui/core/shadcn/button";
import type { TableAction } from "@/lib/ui/core/shadcn/data-table/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/lib/ui/core/shadcn/tooltip";

interface GetHistoryColumnsProps {
  handleGenerateTranscript: (promptText: string) => void;
  handleDownloadTranscript: (promptText: string) => void;
  handleDownloadSummary: (promptText: string) => void;
}

const enum HISTORY_ACTION_TYPE {
  GENERATE_TRANSCRIPT = "generate_transcript",
  DOWNLOAD_TRANSCRIPT = "download_transcript",
  DOWNLOAD_SUMMARY = "download_summary",
}

export const getHistoryColumns = ({
  handleGenerateTranscript,
  handleDownloadTranscript,
  handleDownloadSummary,
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

      const actions: TableAction<HISTORY_ACTION_TYPE>[] = [
        {
          key: HISTORY_ACTION_TYPE.GENERATE_TRANSCRIPT,
          component: (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleGenerateTranscript(entry.id)}
            >
              <LucideFileText />
            </Button>
          ),
          tooltipText: "Generer ny transskription",
        },
        {
          key: HISTORY_ACTION_TYPE.DOWNLOAD_TRANSCRIPT,
          component: (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleDownloadTranscript(entry.id)}
            >
              <LucideFileText />
            </Button>
          ),
          tooltipText: "Hent transskription",
        },
        {
          key: HISTORY_ACTION_TYPE.DOWNLOAD_SUMMARY,
          component: (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleDownloadSummary(entry.id)}
            >
              <LucideFileDown />
            </Button>
          ),
          tooltipText: "Hent opsummering",
        },
      ];

      return (
        <div data-row-action className="flex items-center justify-end">
          {actions.map(({ key, component, tooltipText }) => (
            <Tooltip key={key}>
              <TooltipTrigger asChild>
                <span className="inline-flex">{component}</span>
              </TooltipTrigger>
              <TooltipContent>{tooltipText}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      );
    },
  },
];
